const fs = require("node:fs");
const path = require("node:path");
const { getCorpusForVersion } = require("./corpus");

const PACKAGE_NAME = "Telerik.UI.for.AspNet.Core";
const CDN_PATTERN = /https:\/\/kendo\.cdn\.telerik\.com\/(\d{4}\.\d+\.\d+)\//gi;
const SCRIPT_SRC_PATTERN = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;

/**
 * Walks project files recursively while skipping build and dependency folders.
 */
function walkFiles(root, predicate) {
  if (!fs.existsSync(root)) {
    throw new Error(`project_root does not exist: ${root}`);
  }
  const files = [];
  const stack = [root];
  const ignoredDirs = new Set([".git", ".vs", "bin", "obj", "node_modules", "packages"]);
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          stack.push(path.join(current, entry.name));
        }
      } else if (entry.isFile()) {
        const fullPath = path.join(current, entry.name);
        if (predicate(fullPath)) {
          files.push(fullPath);
        }
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Converts an absolute path to a slash-normalized path relative to a root.
 */
function relativeTo(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

/**
 * Extracts Telerik UI for ASP.NET Core package versions from project XML.
 */
function packageVersionsFromCsproj(xml) {
  const versions = [];
  const selfClosing = /<PackageReference\b([^>]*?)\/>/gi;
  let match;
  while ((match = selfClosing.exec(xml)) !== null) {
    const attributes = match[1];
    if (!new RegExp(`\\bInclude=["']${PACKAGE_NAME.replace(/\./g, "\\.")}["']`, "i").test(attributes)) {
      continue;
    }
    const version = attributes.match(/\bVersion=["']([^"']+)["']/i);
    if (version) {
      versions.push(version[1]);
    }
  }

  const paired = /<PackageReference\b([^>]*?)>([\s\S]*?)<\/PackageReference>/gi;
  while ((match = paired.exec(xml)) !== null) {
    const attributes = match[1];
    if (!new RegExp(`\\bInclude=["']${PACKAGE_NAME.replace(/\./g, "\\.")}["']`, "i").test(attributes)) {
      continue;
    }
    const attributeVersion = attributes.match(/\bVersion=["']([^"']+)["']/i);
    const childVersion = match[2].match(/<Version>\s*([^<]+?)\s*<\/Version>/i);
    if (attributeVersion || childVersion) {
      versions.push((attributeVersion || childVersion)[1]);
    }
  }

  return versions;
}

/**
 * Extracts Kendo CDN versions from script src attributes in Razor markup.
 */
function kendoCdnVersionsFromScriptTags(html) {
  const versions = [];
  let scriptMatch;
  while ((scriptMatch = SCRIPT_SRC_PATTERN.exec(html)) !== null) {
    const src = scriptMatch[2];
    let cdnMatch;
    CDN_PATTERN.lastIndex = 0;
    while ((cdnMatch = CDN_PATTERN.exec(src)) !== null) {
      versions.push(cdnMatch[1]);
    }
  }
  return versions;
}

/**
 * Compares Telerik-style dotted version strings in ascending order.
 */
function compareTelerikVersions(left, right) {
  const leftParts = String(left).split(".");
  const rightParts = String(right).split(".");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] || "0";
    const rightPart = rightParts[index] || "0";
    const leftNumber = Number.parseInt(leftPart, 10);
    const rightNumber = Number.parseInt(rightPart, 10);
    if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) {
      const partComparison = leftPart.localeCompare(rightPart);
      if (partComparison !== 0) {
        return partComparison;
      }
      continue;
    }
    if (leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
  }
  return String(left).localeCompare(String(right));
}

/**
 * Detects project Kendo/Telerik versions and recommends a docs corpus version.
 */
function detectProjectKendoVersions({ project_root } = {}) {
  if (!project_root) {
    throw new Error("project_root is required");
  }
  const root = path.resolve(project_root);
  const warnings = [];

  const packageMatches = [];
  for (const filePath of walkFiles(root, (candidate) => candidate.toLowerCase().endsWith(".csproj"))) {
    const versions = packageVersionsFromCsproj(fs.readFileSync(filePath, "utf8"));
    for (const version of versions) {
      packageMatches.push({ version, source_path: relativeTo(root, filePath) });
    }
  }

  const cdnMatches = [];
  const razorExtensions = new Set([".cshtml", ".razor"]);
  for (const filePath of walkFiles(root, (candidate) => razorExtensions.has(path.extname(candidate).toLowerCase()))) {
    const text = fs.readFileSync(filePath, "utf8");
    for (const version of kendoCdnVersionsFromScriptTags(text)) {
      cdnMatches.push({ version, source_path: relativeTo(root, filePath) });
    }
  }

  const packageVersions = Array.from(new Set(packageMatches.map((entry) => entry.version))).sort(compareTelerikVersions);
  const cdnVersions = Array.from(new Set(cdnMatches.map((entry) => entry.version))).sort(compareTelerikVersions);

  if (packageVersions.length > 1) {
    warnings.push(`Multiple ${PACKAGE_NAME} versions were found: ${packageVersions.join(", ")}.`);
  }
  if (cdnVersions.length > 1) {
    warnings.push(`Multiple Kendo CDN versions were found: ${cdnVersions.join(", ")}.`);
  }

  const aspnetCorePackageVersion = packageVersions[packageVersions.length - 1] || null;
  const recommendedDocsVersion = aspnetCorePackageVersion || cdnVersions[cdnVersions.length - 1] || null;

  if (aspnetCorePackageVersion && cdnVersions.length && !cdnVersions.includes(aspnetCorePackageVersion)) {
    warnings.push(`Telerik package version ${aspnetCorePackageVersion} does not match Kendo CDN version(s): ${cdnVersions.join(", ")}. Preferring the package version.`);
  }
  if (!recommendedDocsVersion) {
    warnings.push(`No ${PACKAGE_NAME} package reference or Kendo CDN version was found.`);
  }

  return {
    project_root: root,
    aspnet_core_package_version: aspnetCorePackageVersion,
    aspnet_core_package_matches: packageMatches,
    kendo_cdn_versions: cdnVersions,
    kendo_cdn_matches: cdnMatches,
    recommended_docs_version: recommendedDocsVersion,
    docs_corpus_available: recommendedDocsVersion ? Boolean(getCorpusForVersion(recommendedDocsVersion)) : false,
    warnings
  };
}

module.exports = {
  PACKAGE_NAME,
  detectProjectKendoVersions,
  kendoCdnVersionsFromScriptTags,
  packageVersionsFromCsproj
};

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  detectProjectKendoVersions
} = require("./project-version");

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kendo-project-version-"));
try {
  fs.writeFileSync(
    path.join(projectRoot, "Old.csproj"),
    `<Project>
  <ItemGroup>
    <PackageReference Include="Telerik.UI.for.AspNet.Core" Version="2024.4.1112" />
  </ItemGroup>
</Project>`
  );
  fs.writeFileSync(
    path.join(projectRoot, "New.csproj"),
    `<Project>
  <ItemGroup>
    <PackageReference Include="Telerik.UI.for.AspNet.Core" Version="2025.3.812" />
  </ItemGroup>
</Project>`
  );

  const result = detectProjectKendoVersions({ project_root: projectRoot });
  assert.equal(result.aspnet_core_package_version, "2025.3.812");
  assert.equal(result.recommended_docs_version, "2025.3.812");
  assert.deepEqual(result.warnings, [
    "Multiple Telerik.UI.for.AspNet.Core versions were found: 2024.4.1112, 2025.3.812."
  ]);
} finally {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

process.stdout.write("Project version tests passed.\n");

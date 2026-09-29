# ============================================================
# build-pgvector-win.ps1 —— Windows 上从源码编译 pgvector（供 pack-windows.sh 合入）
# 背景与两次踩坑记录：
#   ① zonky embedded PG 是纯运行时（无 include/ 无 pg_config.exe），不能当编译底座；
#   ② pgvector 官方 Makefile.win 需要 PGROOT 环境变量（非 PATH 里的 pg_config）。
# 方案：choco 装全量 PG17（含头文件+pg_config）→ PGROOT 指向它 → vcvars64 + nmake →
#       从 PGROOT 归集 vector.dll + control + sql 到 vendor/pgvector-win/。
#       运行时 ABI 兼容：编译产物和随包运行时都取自同一份锁定 EDB PostgreSQL 树。
# 用法（CI 或本机 Windows 管理员环境）：pwsh scripts/build-pgvector-win.ps1
# ============================================================
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$ReleaseLock = Get-Content (Join-Path $root "scripts\release-assets.json") -Raw | ConvertFrom-Json
$PgvectorVer = [string]$ReleaseLock.sourcePins.pgvector.version
$PgvectorRepo = [string]$ReleaseLock.sourcePins.pgvector.repository
$PgvectorCommit = [string]$ReleaseLock.sourcePins.pgvector.commit
$PostgresPackage = [string]$ReleaseLock.sourcePins.windowsPostgresqlBuild.chocolateyPackage
$PostgresPackageVersion = [string]$ReleaseLock.sourcePins.windowsPostgresqlBuild.chocolateyVersion
$PostgresPackageSource = [string]$ReleaseLock.sourcePins.windowsPostgresqlBuild.chocolateySource
$ExpectedPgConfigVersion = [string]$ReleaseLock.sourcePins.windowsPostgresqlBuild.pgConfigVersion
$NupkgName = "$PostgresPackage.$PostgresPackageVersion.nupkg"
$PinnedPackage = $ReleaseLock.assets.PSObject.Properties[$NupkgName].Value
$ExpectedNupkgSha256 = [string]$PinnedPackage.sha256
if (-not $ReleaseLock.sourcePins.windowsPostgresqlBuild.requireChecksums) {
  throw "Windows PostgreSQL 构建底座必须要求 Chocolatey 上游校验和"
}
if ($ExpectedNupkgSha256 -notmatch '^[0-9a-f]{64}$') {
  throw "Windows PostgreSQL Chocolatey 包未被 SHA-256 锁定"
}
$Out = "vendor/pgvector-win"

# ---------- 1. 全量 PG17（编译底座：含 include/ 与 pg_config.exe） ----------
$PgRoot = "C:\Program Files\PostgreSQL\17"
$PgMarker = Join-Path $PgRoot ".workloom-build-source.json"

function Assert-ChocolateyRegistration {
  $installed = @(choco list --exact $PostgresPackage --limit-output)
  if ($LASTEXITCODE -ne 0 -or $installed -notcontains "$PostgresPackage|$PostgresPackageVersion") {
    throw "Chocolatey 本地包登记与锁定版本不符：$($installed -join ', ')"
  }
}

function Get-PgSourceInventory {
  # data/ is a live database cluster; only the toolchain and runtime files are immutable.
  # Pinned pgvector Makefile.win installs only vector.dll, vector SQL/control,
  # and three public headers. Exclude precisely those generated outputs.
  $records = [System.Collections.Generic.List[object]]::new()
  foreach ($subdir in @("bin", "lib", "include", "share")) {
    $directory = Join-Path $PgRoot $subdir
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
      throw "PostgreSQL 构建底座缺少目录：$directory"
    }
    if ((Get-Item -LiteralPath $directory).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      throw "PostgreSQL 构建底座目录不得是重解析点：$directory"
    }
    foreach ($entry in Get-ChildItem -LiteralPath $directory -Recurse -Force) {
      if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "PostgreSQL 构建底座含重解析点，拒绝复用：$($entry.FullName)"
      }
      if ($entry.PSIsContainer) { continue }
      $relative = $entry.FullName.Substring($PgRoot.Length + 1).Replace('\', '/')
      if ($relative -match '^(?i:lib/vector\.dll|share/extension/vector\.control|share/extension/vector--[^/]*\.sql|include/server/extension/vector/(?:halfvec|sparsevec|vector)\.h)$') { continue }
      $records.Add([pscustomobject]@{
        path = $relative
        sha256 = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      })
    }
  }
  return @($records | Sort-Object -Property path)
}

function Assert-PgInventoryEqual($expected, $actual) {
  if ($expected.Count -ne $actual.Count) {
    throw "PostgreSQL 文件集与已验证安装不符"
  }
  for ($index = 0; $index -lt $actual.Count; $index++) {
    if ($expected[$index].path -cne $actual[$index].path -or
        $expected[$index].sha256 -cne $actual[$index].sha256) {
      throw "PostgreSQL 文件内容与已验证安装不符：$($actual[$index].path)"
    }
  }
}

function Assert-PgSourceIdentity {
  Assert-ChocolateyRegistration
  if (-not (Test-Path -LiteralPath "$PgRoot\bin\pg_config.exe" -PathType Leaf)) {
    throw "固定版本 PostgreSQL 缺少 pg_config.exe"
  }
  $actualVersion = (& "$PgRoot\bin\pg_config.exe" --version).Trim()
  if ($actualVersion -ne $ExpectedPgConfigVersion) {
    throw "PostgreSQL 编译底座版本不符：期望 '$ExpectedPgConfigVersion'，实际 '$actualVersion'"
  }
  return $actualVersion
}

if (Test-Path -LiteralPath $PgRoot) {
  # A previous release on the same self-hosted runner may have installed PG17.
  # Preserve any existing installation, including an unrelated one, and reuse only
  # a tree recorded after this script verified the pinned package on an earlier run.
  if ((Get-Item -LiteralPath $PgRoot).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "PostgreSQL 构建目录不得是重解析点：$PgRoot"
  }
  if (-not (Test-Path -LiteralPath $PgMarker -PathType Leaf)) {
    throw "检测到未登记的 PostgreSQL 目录 $PgRoot；拒绝覆盖或卸载已有安装"
  }
  if ((Get-Item -LiteralPath $PgMarker).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "PostgreSQL 构建来源标记不得是重解析点"
  }
  $recorded = Get-Content -LiteralPath $PgMarker -Raw | ConvertFrom-Json
  if ($recorded.schemaVersion -ne 1 -or
      $recorded.package -ne $PostgresPackage -or
      $recorded.packageVersion -ne $PostgresPackageVersion -or
      $recorded.packageSource -ne $PostgresPackageSource -or
      $recorded.packageSha256 -ne $ExpectedNupkgSha256 -or
      $recorded.pgConfigVersion -ne $ExpectedPgConfigVersion) {
    throw "现有 PostgreSQL 构建来源与 release-assets.json 锁定源不符"
  }
  $ActualPgConfigVersion = Assert-PgSourceIdentity
  $currentFiles = @(Get-PgSourceInventory)
  $recordedFiles = @($recorded.files)
  Assert-PgInventoryEqual $recordedFiles $currentFiles
  $BaseInventory = $currentFiles
  Write-Host "✓ 复用已登记且逐文件 SHA-256 复核的 PostgreSQL $ActualPgConfigVersion"
} else {
  Write-Host "→ 安装 PostgreSQL $PostgresPackageVersion（choco 固定包 + 固定源 + 强制上游校验和）…"
  $PackageStage = Join-Path ([System.IO.Path]::GetTempPath()) "workloom-postgresql-package-$PID"
  if (Test-Path $PackageStage) { throw "临时 Chocolatey 包目录已存在，拒绝复用：$PackageStage" }
  New-Item -ItemType Directory -Path $PackageStage | Out-Null
  $NupkgPath = Join-Path $PackageStage $NupkgName
  $NupkgUrl = "$PostgresPackageSource/package/$PostgresPackage/$PostgresPackageVersion"
  curl.exe --fail --location --retry 5 --output $NupkgPath $NupkgUrl
  if ($LASTEXITCODE -ne 0) { throw "固定 Chocolatey 包下载失败：$NupkgUrl" }
  node scripts/release-assets.mjs verify $NupkgPath $NupkgName
  if ($LASTEXITCODE -ne 0) { throw "Chocolatey 包摘要与 release-assets.json 不符" }
  # The pinned nupkg itself pins EDB's installer SHA-256; --require-checksums enforces it.
  choco install $PostgresPackage --version=$PostgresPackageVersion --source=$PackageStage --require-checksums --force -y --no-progress
  if ($LASTEXITCODE -ne 0) { throw "固定版本 PostgreSQL $PostgresPackageVersion 安装失败" }
  $ActualPgConfigVersion = Assert-PgSourceIdentity
  $inventory = @(Get-PgSourceInventory)
  if ($inventory.Count -eq 0) { throw "PostgreSQL 构建底座没有可登记文件" }
  $BaseInventory = $inventory
  $marker = [ordered]@{
    schemaVersion = 1
    package = $PostgresPackage
    packageVersion = $PostgresPackageVersion
    packageSource = $PostgresPackageSource
    packageSha256 = $ExpectedNupkgSha256
    pgConfigVersion = $ExpectedPgConfigVersion
    files = $inventory
  }
  $markerTemporary = "$PgMarker.tmp.$PID"
  [System.IO.File]::WriteAllText($markerTemporary, ($marker | ConvertTo-Json -Depth 4), [System.Text.Encoding]::UTF8)
  [System.IO.File]::Move($markerTemporary, $PgMarker)
  Remove-Item $PackageStage -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host $ActualPgConfigVersion

# ---------- 2. pgvector 源码 ----------
$SourceRoot = Join-Path ([System.IO.Path]::GetTempPath()) "workloom-pgvector-$PID"
if (Test-Path $SourceRoot) { throw "临时源码目录已存在，拒绝复用：$SourceRoot" }
New-Item -ItemType Directory -Path $SourceRoot | Out-Null
git -C $SourceRoot init --quiet
if ($LASTEXITCODE -ne 0) { throw "pgvector 临时仓初始化失败" }
git -C $SourceRoot remote add origin $PgvectorRepo
if ($LASTEXITCODE -ne 0) { throw "pgvector 上游绑定失败" }
git -C $SourceRoot fetch --quiet --depth 1 origin $PgvectorCommit
if ($LASTEXITCODE -ne 0) { throw "pgvector 固定 commit 下载失败：$PgvectorCommit" }
git -C $SourceRoot checkout --quiet --detach FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw "pgvector 固定 commit checkout 失败" }
$ActualPgvectorCommit = (git -C $SourceRoot rev-parse HEAD).Trim()
if ($ActualPgvectorCommit -ne $PgvectorCommit) {
  throw "pgvector 源码 commit 不符：期望 $PgvectorCommit，实际 $ActualPgvectorCommit"
}
Write-Host "✓ pgvector $PgvectorVer source=$ActualPgvectorCommit"

# ---------- 3. MSVC 环境 + nmake（PGROOT 机制） ----------
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vcvars = & $vswhere -latest -find VC\Auxiliary\Build\vcvars64.bat | Select-Object -First 1
if (-not $vcvars) { throw "未找到 vcvars64.bat（需要 Visual Studio C++ 工作负载）" }
Push-Location $SourceRoot
try {
  cmd /c "`"$vcvars`" && set PGROOT=$PgRoot&& nmake /F Makefile.win"
  if ($LASTEXITCODE -ne 0) { throw "nmake 编译失败（exit $LASTEXITCODE）" }
  cmd /c "`"$vcvars`" && set PGROOT=$PgRoot&& nmake /F Makefile.win install"
  if ($LASTEXITCODE -ne 0) { throw "nmake install 失败（exit $LASTEXITCODE）" }
} finally {
  Pop-Location
  Remove-Item $SourceRoot -Recurse -Force -ErrorAction SilentlyContinue
}
$AfterBuildInventory = @(Get-PgSourceInventory)
Assert-PgInventoryEqual $BaseInventory $AfterBuildInventory

# ---------- 3.5 暂存运行时 PG 树（与编译底座同源，ABI 绝对一致） ----------
# 背景：v2.0.13 实证不同 17.x 小版本会让 vector.dll 在运行时缺符号；同时 pgvector
# 0.8.6 官方明确要求 Windows PostgreSQL 17.3+，所以编译与运行统一锁定 EDB 17.11。
# 顺带收益：EDB 全量树含 psql/pg_isready 等完整工具链（zonky 仅三件套）。
$RunPg = "vendor/pg-win"
if (Test-Path $RunPg) { Remove-Item $RunPg -Recurse -Force }
New-Item -ItemType Directory -Force -Path $RunPg | Out-Null
foreach ($d in @("bin", "lib", "share")) {
  Copy-Item "$PgRoot\$d" "$RunPg\$d" -Recurse -Force
}
if (-not (Test-Path "$RunPg\bin\postgres.exe")) { throw "固定版本 PostgreSQL 运行时归集失败" }
Set-Content -Path "$RunPg\WORKLOOM-PROVENANCE.txt" -Encoding utf8 -Value @(
  "postgresql_chocolatey_package=$PostgresPackage"
  "postgresql_chocolatey_version=$PostgresPackageVersion"
  "postgresql_chocolatey_source=$PostgresPackageSource"
  "pg_config_version=$ActualPgConfigVersion"
  "pgvector_version=$PgvectorVer"
  "pgvector_commit=$PgvectorCommit"
)
Write-Host "✓ 运行时 PG 树已暂存：$RunPg（固定版本且与编译底座同源）"

# ---------- 4. 归集产物 ----------
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$Out\lib", "$Out\share\extension" | Out-Null
Copy-Item "$PgRoot\lib\vector.dll" "$Out\lib\" -Force
Copy-Item "$PgRoot\share\extension\vector.control" "$Out\share\extension\" -Force
Copy-Item "$PgRoot\share\extension\vector--*.sql" "$Out\share\extension\" -Force
if (-not (Test-Path "$Out\lib\vector.dll")) { throw "vector.dll 未产出" }
Copy-Item "$RunPg\WORKLOOM-PROVENANCE.txt" "$Out\WORKLOOM-PROVENANCE.txt" -Force
Write-Host "✅ pgvector 编译完成：$Out（vector.dll + control + sql，PGROOT=$PgRoot）"

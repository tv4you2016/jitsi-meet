param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$')]
    [string]$Version,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$androidDirectory = Split-Path $PSScriptRoot -Parent
if (!$OutputDirectory) {
    $OutputDirectory = Join-Path $androidDirectory '.build-tools/maven-repository/release'
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$artifactDirectory = Join-Path $OutputDirectory "org/jitsi/react/jitsi-meet-sdk/$Version"
if (Test-Path -LiteralPath $artifactDirectory) {
    throw "SDK $Version already exists in $artifactDirectory. Choose a new version or output directory."
}
if (!(Test-Path -LiteralPath (Join-Path $androidDirectory '../node_modules/.jitsi/autolinking.json'))) {
    throw 'Install the npm dependencies and run npm run android-autolinking first.'
}
if (!$env:JAVA_HOME -or !(Test-Path -LiteralPath "$env:JAVA_HOME/bin/java.exe")) {
    throw 'Set JAVA_HOME to a JDK 17 installation before running this script.'
}

$previousRepository = $env:MVN_REPO
$previousVersion = $env:OVERRIDE_SDK_VERSION
try {
    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
    $env:MVN_REPO = ([Uri]($OutputDirectory + [IO.Path]::DirectorySeparatorChar)).AbsoluteUri
    $env:OVERRIDE_SDK_VERSION = $Version
    Push-Location $androidDirectory
    try {
        # Publish all RN dependencies in the same Gradle invocation: their
        # generated versions must match the dependency versions in the SDK POM.
        & ./gradlew.bat assembleRelease -x :app:assembleRelease :sdk:testReleaseUnitTest publish "-PsdkVersion=$Version" --no-daemon --console=plain
        if ($LASTEXITCODE -ne 0) {
            throw "SDK build failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }

    $aar = Join-Path $artifactDirectory "jitsi-meet-sdk-$Version.aar"
    $pom = Join-Path $artifactDirectory "jitsi-meet-sdk-$Version.pom"
    if (!(Test-Path -LiteralPath $aar) -or !(Test-Path -LiteralPath $pom)) {
        throw 'The build did not produce both the SDK AAR and POM.'
    }
    Write-Output "SDK $Version and Maven dependencies: $OutputDirectory"
    Write-Output 'Merge this directory into the Maven repository release/ directory, preserving existing versions.'
} finally {
    $env:MVN_REPO = $previousRepository
    $env:OVERRIDE_SDK_VERSION = $previousVersion
}

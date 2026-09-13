import test from "node:test";
import assert from "node:assert/strict";
import {
  DistributionType,
  classifyDistribution,
  scoreExecutables,
  generatePipelineRecipe,
} from "../index";

test("scoreExecutables ranks game binaries over crash handlers and installers", () => {
  const fileList = [
    "setup.exe",
    "unins000.exe",
    "UnityCrashHandler64.exe",
    "CrashReportClient.exe",
    "dxwebsetup.exe",
    "Engine/Binaries/ThirdParty/DotNet/dotnet.exe",
    "Binaries/Win64/RogueWarrior-Win64-Shipping.exe",
    "RogueWarrior.exe",
    "Launcher.exe",
  ];

  const results = scoreExecutables(fileList, "Rogue Warrior");
  assert.ok(results.length > 0);

  // Top candidate should be the Win64 shipping or game exe, NOT setup or crash handler
  const top = results[0];
  assert.ok(
    top.path.includes("RogueWarrior-Win64-Shipping.exe") ||
      top.path.includes("RogueWarrior.exe"),
    `Expected RogueWarrior binary, got ${top.path}`,
  );
  assert.equal(top.isPrimary, true);

  // Excluded binaries should not be present in candidate list
  assert.ok(!results.some((c) => c.path.includes("setup.exe")));
  assert.ok(!results.some((c) => c.path.includes("UnityCrashHandler64.exe")));
  assert.ok(!results.some((c) => c.path.includes("unins000.exe")));
});

test("classifyDistribution identifies Scene multi-part RAR releases", () => {
  const files = [
    "tenoke-winter.survivor.protocol.nfo",
    "tenoke-winter.survivor.protocol.sfv",
    "tenoke-winter.survivor.protocol.rar",
    "tenoke-winter.survivor.protocol.r00",
    "tenoke-winter.survivor.protocol.r01",
  ];

  const result = classifyDistribution(
    "/data/Winter.Survivor.Protocol-TENOKE",
    "Winter Survivor Protocol",
    files,
  );

  assert.equal(result.type, DistributionType.SceneRelease);
  assert.equal(result.releaseGroup, "TENOKE");
  assert.ok(result.multipartRars && result.multipartRars.length >= 3);

  const recipe = generatePipelineRecipe(result, "Winter Survivor Protocol");
  assert.equal(recipe.distributionType, DistributionType.SceneRelease);
  assert.equal(recipe.setupCommand, "drop-pipeline-setup.bat");
  assert.ok(recipe.steps.some((s) => s.action === "extract_rar"));
  assert.ok(recipe.steps.some((s) => s.action === "extract_iso"));
  assert.ok(recipe.steps.some((s) => s.action === "apply_crack"));
  assert.ok(recipe.setupScriptWindows?.includes("TENOKE"));
});

test("generatePipelineRecipe extracts a standalone Scene ISO without a redundant RAR step", () => {
  const files = [
    "tenoke-some.game.nfo",
    "tenoke-some.game.sfv",
    "tenoke-some.game.iso",
  ];

  const result = classifyDistribution(
    "/data/Some.Game-TENOKE",
    "Some Game",
    files,
  );

  assert.equal(result.type, DistributionType.SceneRelease);
  assert.equal(result.primaryArchive, "tenoke-some.game.iso");

  const recipe = generatePipelineRecipe(result, "Some Game");
  assert.equal(recipe.distributionType, DistributionType.SceneRelease);
  assert.ok(
    !recipe.steps.some((s) => s.action === "extract_rar"),
    "standalone ISO must not emit extract_rar",
  );

  const isoStep = recipe.steps.find((s) => s.action === "extract_iso");
  assert.ok(isoStep);
  assert.equal(isoStep.params.sourceGlob, "tenoke-some.game.iso");
  assert.equal(isoStep.params.outputDir, ".");

  const cleanup = recipe.steps.find((s) => s.action === "cleanup");
  assert.ok(cleanup);
  assert.deepEqual(cleanup.params.targets, ["tenoke-some.game.iso"]);

  assert.ok(
    recipe.setupScriptWindows?.includes("Extracting Scene Release ISO"),
  );
  assert.ok(recipe.setupScriptWindows?.includes("tenoke-some.game.iso"));
});

test("classifyDistribution identifies GOG multi-bin installers", () => {
  const files = [
    "setup_amnesia_the_bunker_1.9_(64bit)_(71145)-1.bin",
    "setup_amnesia_the_bunker_1.9_(64bit)_(71145)-2.bin",
    "setup_amnesia_the_bunker_1.9_(64bit)_(71145).exe",
  ];

  const result = classifyDistribution(
    "/data/Amnesia.The.Bunker.v1.9_71145.Windows-GOG",
    "Amnesia: The Bunker",
    files,
  );

  assert.equal(result.type, DistributionType.GogInstaller);
  assert.equal(result.releaseGroup, "GOG");
  assert.equal(
    result.installerExe,
    "setup_amnesia_the_bunker_1.9_(64bit)_(71145).exe",
  );
  assert.equal(result.binChunks?.length, 2);

  const recipe = generatePipelineRecipe(result, "Amnesia: The Bunker");
  assert.equal(recipe.distributionType, DistributionType.GogInstaller);
  assert.ok(recipe.steps.some((s) => s.action === "innoextract"));
  assert.ok(recipe.setupScriptWindows?.includes("innoextract"));
});

test("classifyDistribution identifies FitGirl Repacks", () => {
  const files = [
    "setup.exe",
    "fg-01.bin",
    "fg-02.bin",
    "fg-optional-soundtrack.bin",
    "Verify BIN files before installation.bat",
  ];

  const result = classifyDistribution(
    "/data/Star Wars Outlaws [FitGirl Repack]",
    "Star Wars Outlaws",
    files,
  );

  assert.equal(result.type, DistributionType.FitGirlRepack);
  assert.equal(result.releaseGroup, "FitGirl");
  assert.equal(result.installerExe, "setup.exe");
  assert.equal(result.binChunks?.length, 3);

  const recipe = generatePipelineRecipe(result, "Star Wars Outlaws");
  assert.equal(recipe.distributionType, DistributionType.FitGirlRepack);
  assert.equal(recipe.setupCommand, "drop-pipeline-setup.bat");
});

test("classifyDistribution identifies KaOs Repacks", () => {
  const files = ["Install.exe", "KaOs-01.bin", "KaOs.nfo"];

  const result = classifyDistribution(
    "/data/Rogue.Warrior.2009.REPACK-KaOs",
    "Rogue Warrior",
    files,
  );

  assert.equal(result.type, DistributionType.KaOsRepack);
  assert.equal(result.releaseGroup, "KaOs");
  assert.equal(result.installerExe, "Install.exe");

  const recipe = generatePipelineRecipe(result, "Rogue Warrior");
  assert.equal(recipe.distributionType, DistributionType.KaOsRepack);
  assert.equal(recipe.setupCommand, "drop-pipeline-setup.bat");
});

test("classifyDistribution identifies Standalone 7z Archives", () => {
  const files = ["10 Dead Doves v1.2 [Build 17332128].7z"];

  const result = classifyDistribution(
    "/data/10 Dead Doves (2024)",
    "10 Dead Doves",
    files,
  );

  assert.equal(result.type, DistributionType.ArchiveBundle);
  assert.equal(result.primaryArchive, "10 Dead Doves v1.2 [Build 17332128].7z");

  const recipe = generatePipelineRecipe(result, "10 Dead Doves");
  assert.equal(recipe.distributionType, DistributionType.ArchiveBundle);
  assert.ok(recipe.steps.some((s) => s.action === "extract_archive"));
});

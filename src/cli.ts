import { printError, getOutputFormat, printOutput, type CommandMeta, formatCommandHelp } from "./output";
import {
  isPrivateHost,
  isMediaHost,
  NOT_VIDEO_BRANDS,
  mediaExt,
  safeSeg,
  authorSeg,
  postId,
  postDir,
  downloadPostMedia,
  resolveHomePath,
  parseDataUrl,
  screenshotPath,
  profileDir,
  profileMarkdown,
  downloadProfile,
  instagramProfileUrl,
  profileUrl,
} from "./media";
import { runDoctor, runUpdate } from "./lib/client";
import { extensionVersion, CliError, PINNED_EXTENSION_ID } from "./lib/state";
import { runServiceDaemon } from "./service";
import { COMMAND_REGISTRY, formatRootHelp, printHelp, dispatch } from "./commands";

const argv = Bun.argv;
if (argv[2] === "--service-daemon") {
  await runServiceDaemon();
} else if (argv[2] === "--version") {
  console.log(extensionVersion);
} else if (argv.includes("--help")) {
  printHelp(argv);
} else {
  await dispatch(argv);
}

// Re-exports kept for tests and external importers; the logic lives in the modules.
export {
  CliError,
  PINNED_EXTENSION_ID,
  isPrivateHost,
  isMediaHost,
  NOT_VIDEO_BRANDS,
  mediaExt,
  safeSeg,
  authorSeg,
  postId,
  postDir,
  downloadPostMedia,
  parseDataUrl,
  screenshotPath,
  resolveHomePath,
  profileDir,
  downloadProfile,
  profileMarkdown,
  instagramProfileUrl,
  profileUrl,
  COMMAND_REGISTRY,
  type CommandMeta,
  formatCommandHelp,
  formatRootHelp,
  getOutputFormat,
  printOutput,
  printError,
  runDoctor,
  runUpdate,
};

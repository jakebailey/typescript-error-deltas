import octokit = require("@octokit/rest");
import ge = require("@typescript/get-errors");
import git = require("@typescript/git-utils");
import ip = require("@typescript/install-packages");
import pu = require("@typescript/package-utils");
import cp = require("child_process");
import fs = require("fs");
import path = require("path");

const { argv } = process;

if (argv.length !== 6) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} {repo_count} {old_tsc_version} {new_tsc_version} {file_issue}`);
    process.exit(-1);
}

const processCwd = process.cwd();

const repoCount = +argv[2];
const oldTscVersion = argv[3];
const newTscVersion = argv[4];
const fileIssue = argv[5].toLowerCase() !== "false";

mainAsync().catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});

const tenMinutes = 10 * 60 * 1000;

async function mainAsync() {
    const downloadDir = "/mnt/ts_downloads";
    await execAsync(processCwd, "sudo", ["mkdir", downloadDir]);

    const { tscPath: oldTscPath, resolvedVersion: oldTscResolvedVersion } = await downloadTypeScriptAsync(processCwd, oldTscVersion);
    const { tscPath: newTscPath, resolvedVersion: newTscResolvedVersion } = await downloadTypeScriptAsync(processCwd, newTscVersion);

    console.log("Old version = " + oldTscResolvedVersion);
    console.log("New version = " + newTscResolvedVersion);

    const repos = await git.getPopularTypeScriptRepos(repoCount);

    let summary = "";
    let sawNewErrors = false;

    for (const repo of repos) {
        if (repo.url === "https://github.com/storybookjs/storybook") {
            // Consistently causes VM to run out of disk space
            continue;
        }

        console.log("Starting " + repo.url);

        await execAsync(processCwd, "sudo", ["mount", "-t", "tmpfs", "-o", "size=2g", "tmpfs", downloadDir]);

        try {
            try {
                console.log("Cloning if absent");
                await git.cloneRepoIfNecessary(downloadDir, repo);
            }
            catch (err) {
                reportError(err, "Error cloning " + repo.url);
                continue;
            }

            const repoDir = path.join(downloadDir, repo.name);

            try {
                console.log("Installing packages if absent");
                await withTimeout(tenMinutes, installPackages(repoDir));
            }
            catch (err) {
                reportError(err, "Error installing packages for " + repo.url);
                await reportResourceUsage(downloadDir);
                continue;
            }

            try {
                console.log(`Building with ${oldTscPath} (old)`);
                const oldErrors = await withTimeout(tenMinutes, ge.buildAndGetErrors(repoDir, oldTscPath, /*skipLibCheck*/ true));

                if (oldErrors.hasConfigFailure) {
                    console.log("Unable to build project graph");
                    console.log(`Skipping build with ${newTscPath} (new)`);
                    continue;
                }

                const numProjects = oldErrors.projectErrors.length;

                let numFailed = 0;
                for (const oldProjectErrors of oldErrors.projectErrors) {
                    if (oldProjectErrors.hasBuildFailure || oldProjectErrors.errors.length) {
                        numFailed++;
                    }
                }

                if (numFailed === numProjects) {
                    console.log(`Skipping build with ${newTscPath} (new)`);
                    continue;
                }

                let sawNewRepoErrors = false;
                let repoSummary = `# [${repo.name}](${repo.url})\n`;

                if (numFailed > 0) {
                    const oldFailuresMessage = `${numFailed} of ${numProjects} projects failed to build with the old tsc`;
                    console.log(oldFailuresMessage);
                    repoSummary += `**${oldFailuresMessage}**\n`;
                }

                console.log(`Building with ${newTscPath} (new)`);
                const newErrors = await withTimeout(tenMinutes, ge.buildAndGetErrors(repoDir, newTscPath, /*skipLibCheck*/ true));

                if (newErrors.hasConfigFailure) {
                    console.log("Unable to build project graph");

                    sawNewErrors = true;
                    repoSummary += ":exclamation::exclamation: **Unable to build the project graph with the new tsc** :exclamation::exclamation:\n";

                    summary += repoSummary;
                    continue;
                }

                console.log("Comparing errors");
                for (const oldProjectErrors of oldErrors.projectErrors) {
                    // To keep things simple, we'll focus on projects that used to build cleanly
                    if (oldProjectErrors.hasBuildFailure || oldProjectErrors.errors.length) {
                        continue;
                    }

                    const newProjectErrors = newErrors.projectErrors.find(pe => pe.projectUrl == oldProjectErrors.projectUrl);
                    if (!newProjectErrors || !newProjectErrors.errors.length) {
                        continue;
                    }

                    sawNewRepoErrors = true;

                    const errorMessageMap = new Map<string, ge.Error[]>();
                    const errorMessages: string[] = [];

                    console.log(`New errors for ${oldProjectErrors.isComposite ? "composite" : "non-composite"} project ${oldProjectErrors.projectUrl}`);
                    for (const newError of newProjectErrors.errors) {
                        const newErrorText = newError.text;

                        console.log(`\tTS${newError.code} at ${newError.fileUrl ?? "project scope"}${oldProjectErrors.isComposite ? ` in ${newError.projectUrl}` : ``}`);
                        console.log(`\t\t${newErrorText}`);

                        if (!errorMessageMap.has(newErrorText)) {
                            errorMessageMap.set(newErrorText, []);
                            errorMessages.push(newErrorText);
                        }

                        errorMessageMap.get(newErrorText)!.push(newError);
                    }

                    repoSummary += `### ${makeMarkdownLink(oldProjectErrors.projectUrl)}\n`
                    for (const errorMessage of errorMessages) {
                        repoSummary += ` - \`${errorMessage}\`\n`;

                        for (const error of errorMessageMap.get(errorMessage)!) {
                            repoSummary += `   - ${error.fileUrl ? makeMarkdownLink(error.fileUrl) : "Project Scope"}${oldProjectErrors.isComposite ? ` in ${makeMarkdownLink(error.projectUrl)}` : ``}\n`;
                        }
                    }
                }

                if (sawNewRepoErrors) {
                    sawNewErrors = true;
                    summary += repoSummary;
                }
            }
            catch (err) {
                reportError(err, "Error building " + repo.url);
                continue;
            }

            console.log("Done " + repo.url);
        }
        finally {
            // Throw away the repo so we don't run out of space
            // Note that we specifically don't recover and attempt another repo if this fails
            console.log("Cleaning up repo");
            await execAsync(processCwd, "sudo", ["umount", downloadDir]);
            await reportResourceUsage(downloadDir);
        }
    }

    if (!fileIssue) {
        return;
    }

    console.log("Creating a summary issue");

    const kit = new octokit.Octokit({
        auth: process.env.GITHUB_PAT,
    });

    const repoProperties = {
        owner: "microsoft",
        repo: "typescript",
    };

    const created = await kit.issues.create({
        ...repoProperties,
        title: `[NewErrors] ${newTscResolvedVersion} vs ${oldTscResolvedVersion}`,
        body: `The following errors were reported by ${newTscResolvedVersion}, but not by ${oldTscResolvedVersion}

${summary}`,
    });

    const issueNumber = created.data.number;
    console.log(`Created issue #${issueNumber}: ${created.data.html_url}`);

    if (!sawNewErrors) {
        await kit.issues.update({
            ...repoProperties,
            issue_number: issueNumber,
            state: "closed",
        });
    }
}

async function installPackages(repoDir: string) {
    const commands = await ip.restorePackages(repoDir, /*ignoreScripts*/ true);
    for (const { directory: packageRoot, tool, arguments: args } of commands) {
        await execAsync(packageRoot, tool, args);
    }
}

function withTimeout<T>(ms: number, promise: Promise<T>): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_resolve, reject) =>
            setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms)),
    ]);
}

async function reportResourceUsage(downloadDir: string) {
    console.log("Memory");
    console.log(await execAsync(processCwd, "free", ["-h"]));
    console.log("Disk");
    console.log(await execAsync(processCwd, "df", ["-h"]));
    console.log(await execAsync(processCwd, "df", ["-i"]));
    console.log("Working Directory");
    console.log(await execAsync(processCwd, "ls", ["-alh"]));
    console.log("Download Directory");
    console.log(await execAsync(processCwd, "ls", ["-alh", downloadDir]));
    console.log("Home Directory");
    console.log(await execAsync(processCwd, "ls", ["-alh", "~"]));
    console.log(await execAsync(processCwd, "du", ["-csh", "~/.[^.]*"]));
}

function reportError(err: any, message: string) {
    console.log(message);
    console.log(reduceSpew(err.message));
    console.log(reduceSpew(err.stack ?? "Unknown Stack"));
}

async function execAsync(cwd: string, command: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) =>
        cp.execFile(command, args, { cwd }, (err, stdout, _stderr) => {
            if (err) {
                reject(err);
            }
            resolve(stdout);
        }));
}

function reduceSpew(message: string): string {
    // Since this is only a warning, it tends to be reported many (i.e. thousands of) times
    const problemString = "npm WARN tar ENOSPC: no space left on device, write\n";
    const index = message.indexOf(problemString);
    if (index < 0) return message;

    return message.substring(0, index) + problemString + replaceAll(message.substring(index), problemString, "");
}

function replaceAll(message: string, oldStr: string, newStr: string) {
    let result = "";
    let index = 0;
    while (true) {
        const newIndex = message.indexOf(oldStr, index);
        if (newIndex < 0) {
            return index === 0
                ? message
                : result + message.substring(index);
        }

        result += message.substring(index, newIndex);
        result += newStr;

        index = newIndex + oldStr.length;
    }
}

function makeMarkdownLink(url: string) {
    const match = /\/blob\/[a-f0-9]+\/(.+)$/.exec(url);
    return !match
        ? url
        : `[${match[1]}](${url})`;
}

async function downloadTypeScriptAsync(cwd: string, version: string): Promise<{ tscPath: string, resolvedVersion: string }> {
    const tarName = (await execAsync(cwd, "npm", ["pack", `typescript@${version}`, "--quiet"])).trim();

    const tarMatch = /^(typescript-(.+))\..+$/.exec(tarName);
    if (!tarMatch) {
        throw new Error("Unexpected tarball name format: " + tarName);
    }

    const resolvedVersion = tarMatch[2];
    const dirName = tarMatch[1];
    const dirPath = path.join(processCwd, dirName);

    await execAsync(cwd, "tar", ["xf", tarName]);
    await fs.promises.rename(path.join(processCwd, "package"), dirPath);

    const tscPath = path.join(dirPath, "lib", "tsc.js");
    if (!await pu.exists(tscPath)) {
        throw new Error("Cannot find file " + tscPath);
    }

    return { tscPath, resolvedVersion };
}
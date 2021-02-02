import {join, resolve, sep} from "path"
import {readFileSync} from "fs"
import {exec} from "@actions/exec"
import * as core from "@actions/core"
import {context, GitHub} from "@actions/github"
import type {Octokit} from "@octokit/rest"
import flatMap from "lodash/flatMap"
import filter from "lodash/filter"
import map from "lodash/map"
import strip from "strip-ansi"
import table from "markdown-table"
import {CoverageMap, CoverageMapData, createCoverageMap} from "istanbul-lib-coverage"
import type {FormattedTestResults} from "@jest/test-result/build/types"

const COVERAGE_HEADER = ":loop: **Code coverage**\n\n"
const TOTAL_COVERAGE_HEADER = "All statements coverage: "

export async function run() {
  let workingDirectory = core.getInput("working-directory", {required: false})
  let cwd = workingDirectory ? resolve(workingDirectory) : process.cwd()
  const CWD = cwd + sep
  const RESULTS_FILE = join(CWD, "jest.results.json")

  try {
    const token = process.env.GITHUB_TOKEN
    if (token === undefined) {
      core.error("GITHUB_TOKEN not set.")
      core.setFailed("GITHUB_TOKEN not set.")
      return
    }

    const cmd = getJestCommand(RESULTS_FILE)

    await execJest(cmd, CWD)

    // octokit
    const octokit = new GitHub(token)

    // Parse results
    const results = parseResults(RESULTS_FILE)

    const covMap = createCoverageMap((results.coverageMap as unknown) as CoverageMapData)
    const statementsCov = Math.trunc(covMap.getCoverageSummary().statements.pct);

    core.info("All statements coverage: " + statementsCov + "%")

    const minCov = getMinCoverage()
    const isPR = !!getPullId()

    const isCovOk = statementsCov >= minCov
    let covErrString = isCovOk ? "" : `Test coverage fall behind ${minCov}% threshold (actual - ${statementsCov}%).`
    const comment = getComment(covMap, statementsCov, covErrString, CWD)
    const checkPayload = getCheckPayload(results, CWD, isCovOk, covErrString, comment)
    await octokit.checks.create(checkPayload)


    // Coverage comments
    if (getPullId() && shouldCommentCoverage()) {
      if (comment) {
        await deletePreviousComments(octokit)
        const commentPayload = getCommentPayload(comment)
        await octokit.issues.createComment(commentPayload)
      }
    }

    if (!results.success) {
      core.setFailed("Some jest tests failed.")
    }
    if (!isCovOk) {
      if (isPR) {
        core.setFailed(covErrString)
      } else {
        core.warning(covErrString)
      }
    }
  } catch (error) {
    console.error(error)
    core.setFailed(error.message)
  }
}

async function deletePreviousComments(octokit: GitHub) {
  const {data} = await octokit.issues.listComments({
    ...context.repo,
    per_page: 100,
    issue_number: getPullId(),
  })
  return Promise.all(
    data
      .filter(
        (c) =>
          c.user.login === "github-actions[bot]" && c.body.startsWith(COVERAGE_HEADER),
      )
      .map((c) => octokit.issues.deleteComment({...context.repo, comment_id: c.id})),
  )
}

function shouldCommentCoverage(): boolean {
  return Boolean(JSON.parse(core.getInput("coverage-comment", {required: false})))
}

function shouldRunOnlyChangedFiles(): boolean {
  return Boolean(JSON.parse(core.getInput("changes-only", {required: false})))
}

function getMinCoverage(): number {
  return Number(JSON.parse(core.getInput("min-coverage", {required: false})))
}

function getComment(
  covMap: CoverageMap,
  statementsCov: number,
  covErrString: string,
  cwd: string,
): string | false {

  const coverageTable = getCoverageTable(covMap, cwd)
  if (coverageTable) {
    if (covErrString) {
      return COVERAGE_HEADER + covErrString + "\n" + coverageTable
    } else {
      return COVERAGE_HEADER + TOTAL_COVERAGE_HEADER + statementsCov + "%\n" + coverageTable
    }
  }
  return false
}

export function getCoverageTable(
  covMap: CoverageMap,
  cwd: string,
): string | false {

  const rows = [["Filename", "Statements", "Branches", "Functions", "Lines"]]

  for (const [filename, data] of Object.entries(covMap.data || {})) {
    const {data: summary} = data.toSummary()
    rows.push([
      filename.replace(cwd, ""),
      summary.statements.pct + "%",
      summary.branches.pct + "%",
      summary.functions.pct + "%",
      summary.lines.pct + "%",
    ])
  }

  return table(rows, {align: ["l", "r", "r", "r", "r"]})
}

function getCommentPayload(body: string) {
  const payload: Octokit.IssuesCreateCommentParams = {
    ...context.repo,
    body,
    issue_number: getPullId(),
  }
  return payload
}

function getCheckPayload(results: FormattedTestResults,
                         cwd: string,
                         isCovOk: boolean,
                         covErrString: string,
                         comment: string | false
) {
  let conclusion:
    | "success"
    | "failure"
    | "neutral"
  let title

  if (results.success) {
    if (isCovOk) {
      conclusion = "success"
      title = "Jest tests passed"
    } else {
      conclusion = "failure"
      title = covErrString
    }
  } else {
    conclusion = "failure"
    title = "Jest tests failed"
  }

  const testSummary = results.success
    ? `${results.numPassedTests} tests passing in ${
      results.numPassedTestSuites
    } suite${results.numPassedTestSuites > 1 ? "s" : ""}.`
    : `Failed tests: ${results.numFailedTests}/${results.numTotalTests}. Failed suites: ${results.numFailedTests}/${results.numTotalTestSuites}.`

  const summary = testSummary + "\n\n" + comment

  const name = results.success ? "Code coverage" : "Unit test error"

  const payload: Octokit.ChecksCreateParams = {
    ...context.repo,
    head_sha: getSha(),
    name: name,
    status: "completed",
    conclusion: conclusion,
    output: {
      title: title,
      text: getOutputText(results),
      summary: summary,
      annotations: getAnnotations(results, cwd),
    },
  }
  console.debug("Check payload: %j", payload)
  return payload
}

function getJestCommand(resultsFile: string) {
  let cmd = core.getInput("test-command", {required: false})
  const jestOptions = `--testLocationInResults --json ${
    shouldCommentCoverage() ? "--coverage" : ""
  } ${
    shouldRunOnlyChangedFiles() && context.payload.pull_request?.base.ref
      ? "--changedSince=" + context.payload.pull_request?.base.ref
      : ""
  } --outputFile=${resultsFile}`
  const isNpm = cmd.startsWith("npm") || cmd.startsWith("npx")
  cmd += (isNpm ? " -- " : " ") + jestOptions
  core.debug("Final test command: " + cmd)
  return cmd
}

function parseResults(resultsFile: string): FormattedTestResults {
  return JSON.parse(readFileSync(resultsFile, "utf-8"))
}

async function execJest(cmd: string, cwd?: string) {
  try {
    await exec(cmd, [], {silent: true, cwd})
    console.debug("Jest command executed")
  } catch (e) {
    console.error("Jest execution failed. Tests have likely failed.", e)
  }
}

function getPullId(): number {
  return context.payload.pull_request?.number ?? 0
}

function getSha(): string {
  return context.payload.pull_request?.head.sha ?? context.sha
}

const getAnnotations = (
  results: FormattedTestResults,
  cwd: string,
): Octokit.ChecksCreateParamsOutputAnnotations[] => {
  if (results.success) {
    return []
  }
  return flatMap(results.testResults, (result) => {
    return filter(result.assertionResults, ["status", "failed"]).map((assertion) => ({
      path: result.name.replace(cwd, ""),
      start_line: assertion.location?.line ?? 0,
      end_line: assertion.location?.line ?? 0,
      annotation_level: "failure",
      title: assertion.ancestorTitles.concat(assertion.title).join(" > "),
      message: strip(assertion.failureMessages?.join("\n\n") ?? ""),
    }))
  })
}

const getOutputText = (results: FormattedTestResults) => {
  if (results.success) {
    return
  }
  const entries = filter(map(results.testResults, (r) => strip(r.message)))
  return asMarkdownCode(entries.join("\n"))
}

export function asMarkdownCode(str: string) {
  return "```\n" + str.trimRight() + "\n```"
}

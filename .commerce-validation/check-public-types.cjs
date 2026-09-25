'use strict';
// Fork-only evidence runner. Not part of the proposed three-file upstream patch.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const names = [
  'QueryParamsWithFormat', 'ResultJSONType', 'RowJSONType', 'ResultStream',
  'PingParams', 'PingParamsWithEndpoint', 'PingParamsWithSelectQuery',
  'ClickHouseSummary', 'WithClickHouseSummary', 'WithResponseHeaders',
];
const surfaces = {
  '@clickhouse/client': 'packages/client-node/dist/index.d.ts',
  '@clickhouse/client-web': 'packages/client-web/dist/index.d.ts',
};

function inspect(ts, root) {
  const configPath = path.join(root, 'tests/public-types/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert(!config.error, 'Cannot read the consumer tsconfig');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), undefined, configPath);
  assert.equal(parsed.errors.length, 0, 'Invalid consumer tsconfig');
  assert.equal(parsed.options.noEmit, true, 'Consumer must not emit runtime output');
  assert(!parsed.options.paths, 'Private-source path aliases are not allowed');
  const fixture = path.join(root, 'tests/public-types/exports.ts');
  assert(parsed.fileNames.includes(fixture), 'Consumer fixture is not included');
  const resolutions = {};
  for (const [name, relative] of Object.entries(surfaces)) {
    const resolved = ts.resolveModuleName(name, fixture, parsed.options, ts.sys).resolvedModule;
    assert(resolved, `Cannot resolve ${name}`);
    const actual = fs.realpathSync(resolved.resolvedFileName);
    const expected = fs.realpathSync(path.join(root, relative));
    assert.equal(actual, expected, `${name} resolved outside the built checkout`);
    resolutions[name] = actual;
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ({
    code: d.code,
    file: d.file ? path.relative(root, d.file.fileName) : null,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  }));
  return { resolutions, diagnostics };
}

function missingExport(d, name, surface) {
  return [2305, 2724].includes(d.code)
    && d.file === 'tests/public-types/exports.ts'
    && d.message.includes(`'${name}'`)
    && (d.message.includes(`"${surface}"`) || d.message.includes(`'${surface}'`));
}

function requireRed(result, targets) {
  for (const [name, surface] of targets) {
    assert(result.diagnostics.some((d) => missingExport(d, name, surface)),
      `Expected a missing-export diagnostic for ${surface}:${name}`);
  }
  assert(result.diagnostics.every((d) => targets.some(([n, s]) => missingExport(d, n, s))),
    'Unrelated compiler errors cannot count as the expected regression');
}

function removeNamedExport(ts, source, name) {
  const sf = ts.createSourceFile('index.d.ts', source, ts.ScriptTarget.Latest, true);
  let matches = 0;
  const updated = ts.factory.updateSourceFile(sf, sf.statements.map((statement) => {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)) return statement;
    const elements = statement.exportClause.elements.filter((element) => {
      if (element.name.text !== name) return true;
      matches++;
      return false;
    });
    return ts.factory.updateExportDeclaration(statement, statement.modifiers,
      statement.isTypeOnly, ts.factory.updateNamedExports(statement.exportClause, elements),
      statement.moduleSpecifier, statement.attributes);
  }));
  assert.equal(matches, 1, `Expected exactly one named re-export of ${name}`);
  return ts.createPrinter().printFile(updated);
}

function verify(ts, root, mode) {
  assert(['base', 'head'].includes(mode), 'Expected base or head');
  const initial = inspect(ts, root);
  if (mode === 'base') {
    requireRed(initial, Object.keys(surfaces).flatMap((s) => names.map((n) => [n, s])));
    return { mode, typescript: ts.version, ...initial, expected_failure_confirmed: true };
  }
  assert.deepEqual(initial.diagnostics, [], 'Positive consumer compilation failed');
  const mutations = [];
  for (const [surface, relative] of Object.entries(surfaces)) {
    const file = path.join(root, relative);
    const original = fs.readFileSync(file, 'utf8');
    try {
      for (const name of names) {
        fs.writeFileSync(file, removeNamedExport(ts, original, name));
        const result = inspect(ts, root);
        requireRed(result, [[name, surface]]);
        mutations.push({ surface, name, rejected: true });
      }
    } finally {
      fs.writeFileSync(file, original);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'Declaration restoration failed');
  }
  assert.deepEqual(inspect(ts, root).diagnostics, [], 'Restored consumer compilation failed');
  return { mode, typescript: ts.version, resolutions: initial.resolutions,
    positive_passed: true, mutations, restored_passed: true };
}

if (require.main === module) {
  try {
    const [mode, directory] = process.argv.slice(2);
    assert(directory, 'Usage: node check-public-types.cjs base|head CHECKOUT');
    const root = fs.realpathSync(directory);
    // Deliberately no global-compiler fallback.
    const ts = require(path.join(root, 'node_modules/typescript'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    assert.equal(ts.version, lock.packages['node_modules/typescript'].version,
      'Installed compiler differs from the checkout lockfile');
    const result = verify(ts, root, mode);
    fs.writeFileSync(path.join(process.env.RUNNER_TEMP || process.cwd(), `public-types-${mode}-receipt.json`), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}
module.exports = { names, surfaces, inspect, requireRed, removeNamedExport, verify };

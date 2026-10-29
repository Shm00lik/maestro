import { describe, it, expect } from 'vitest';
import { isSafeTaskCommand, safeScopeFor } from '../../src/engine/safeCommands.js';

const ALLOWED: string[] = [
  // test runners
  'npm test', 'npm run test', 'npm t', 'pnpm test', 'yarn test', 'npm test --silent', 'npm test -s',
  'npm test -- --run', 'npm test -- test/strings.test.js', 'npm run test -- --reporter=dot', '  npm test  ',
  'node --test', 'node --test test/strings.test.js test/numbers.test.js', 'node --test ./test',
  // git read
  'git status', 'git status --short', 'git status -sb', 'git status --porcelain=v1',
  'git diff', 'git diff --stat', 'git diff HEAD~1', 'git diff --cached src/a.js', 'git diff -- src',
  'git log', 'git log --oneline -5', 'git log -n 3 --format=%h', 'git log --name-only',
  'git show', 'git show HEAD', 'git show HEAD^', 'git show HEAD:src/strings.js', 'git show --stat HEAD',
  // git add / commit
  'git add src/strings.js test/strings.test.js', 'git add .', 'git add -A', 'git add -- src', 'git add -u',
  'git commit -m "feat: add capitalize"', "git commit -m 'feat: add capitalize'", 'git commit -q -m "x"',
  'git commit -am "fix: thing"', 'git commit -m "title" -m "body text, more"', 'git commit -m wip',
  'git commit --no-verify -m "x"', 'git commit -m "a message with \'single\' quotes"',
  'git commit -m "feat!: breaking change #12"', 'git commit -m "path a/b.js and HEAD~1 are just words: ok"',
  // the exact commands from the 2026-10-29 run (#2, #4/#5 without the heredoc)
  'mkdir -p src test',
  'git add src/strings.js test/strings.test.js && git commit -q -m "feat: add capitalize"',
  'npm test && git add src/numbers.js && git commit -m "feat: add numbers"',
  // mkdir / ls / pwd
  'mkdir src', 'mkdir -p src/lib/deep', 'ls', 'ls -la', 'ls src test', 'ls -1 ./src', 'pwd',
  'mkdir -p src && ls src && pwd',
];

const REJECTED: string[] = [
  // the run's #3/#7: pipe and redirection
  'npm test 2>&1 | tail -15',
  // shell operators and substitution, in either shell
  'npm test; rm -rf .', 'npm test || true', 'npm test | cat', 'npm test > out.txt', 'npm test < in.txt',
  'npm test &', 'npm test & rm x', 'npm test &&git status', 'npm test&& git status', 'npm test &&  ',
  ' && npm test', 'npm test && ', 'npm test &&& git status',
  'git commit -m "$(rm -rf .)"', 'git commit -m "`id`"', 'git commit -m "$HOME"', 'echo $(ls)',
  'git commit -m "feat(core): scoped"', 'git status (x)', 'ls @(1)', 'git log {a}', 'git show HEAD@{1}',
  'git commit -m "line1\nline2"', 'npm test\nrm -rf .', 'npm test\r\nx', 'npm\ttest',
  'git commit -m "a\\" && rm -rf x && echo \\""', 'git commit -m "it\u2019s"', 'git commit -m \u201cx\u201d',
  'npm test\u00a0--script-shell=x', 'git commit -m "caf\u00e9"',
  // heredocs and file writes from the run (#4/#5)
  "cat > src/strings.js << 'EOF'\nexport const x = 1;\nEOF", "printf 'x' > src/numbers.js",
  // quoting
  'git commit -m "unterminated', 'git commit -m "a""b"', 'git commit -m "a"b', 'git add "src/a.js"',
  "git commit -m 'it''s'", 'npm "test"', 'git status "x"',
  // not on the list
  'rm -rf src', 'cat src/a.js', 'npm install', 'npm run build', 'npm run test:watch', 'npx vitest',
  'node script.js', 'node -e "1"', 'node --test --require ./x.js', 'node --test=x', 'yarn', 'npm', 'git',
  'git push', 'git push origin main', 'git pull', 'git fetch', 'git checkout main', 'git reset --hard',
  'git rebase main', 'git merge x', 'git branch -D x', 'git remote add o u', 'git config user.name x',
  'git clean -fdx', 'git stash', 'git rm src/a.js', 'git mv a b', 'git restore .', 'git tag v1',
  'git log push', 'git diff checkout', 'git add push',
  'cd .. && npm test', 'cd src', 'sudo npm test', 'FOO=1 npm test', 'Remove-Item x', 'ls env:', 'ls HKCU:',
  'pwd -P', 'mkdir', 'mkdir -p', 'git add', 'git commit', 'git commit -m', 'git commit -q',
  // git global options and dangerous flags
  'git -C .. status', 'git --git-dir=x status', 'git status -C ..', 'git log -c', 'git diff -C', 'git log -cC',
  'git -c core.pager=x log', 'git --work-tree=. status', 'git diff --output=x.txt', 'git diff --out=x',
  'git log --o=x', 'git diff --ext-diff', 'git diff --no-index a b', 'git show --textconv HEAD',
  'git log --exec-path=x', 'git status --git-dir=x', 'git log --paginate', 'git log --no', 'git log --%',
  // commit and add flags not on the list
  'git commit --amend -m "x"', 'git commit -F msg.txt', 'git commit --author=x -m "y"', 'git commit -m"x"',
  'git commit --message=x', 'git commit -e -m "x"', 'git commit -m -x', 'git commit "x"',
  'git add -p', 'git add -i', 'git add -e', 'git add -f x', 'git add --chmod=+x a', 'git add -- -rf',
  // test runner flags and arguments
  'npm test --script-shell=./evil.sh', 'npm test --prefix=sub', 'npm test -- %PATH%', 'npm test -- a^b',
  'npm test -- ../x', 'npm test -- /etc', 'npm test x', 'npm test -- "a b"', 'yarn test src/x.test.js',
  // paths outside the worktree
  'git add ../x', 'git add /etc/passwd', 'git add ~/x', 'git add C:/x', 'git add src/../../x', 'mkdir /tmp/x',
  'mkdir ~/x', 'mkdir ../x', 'mkdir C:x', 'ls ..', 'ls /', 'ls ~', 'node --test ../x.test.js', 'node --test /x',
  'git diff main..HEAD', 'git diff main...HEAD', 'git show HEAD:../x', 'git log -- /etc', 'git diff --stat=/x',
  'git log --format=~x', 'git log --relative=C:x', 'git diff a:/b', 'git log @foo',
  // globs and odd tokens
  'git add *', 'git add src/*.js', 'ls *', 'mkdir -p src/?', 'git status #x', 'mkdir -rf',
  // empty / non-string / too long
  '', '   ', 'git status '.repeat(200),
  Array.from({ length: 9 }, () => 'git status').join(' && '),
];

describe('isSafeTaskCommand', () => {
  it.each(ALLOWED)('allows %j', cmd => {
    expect(isSafeTaskCommand(cmd)).toBe(true);
  });

  it.each(REJECTED)('rejects %j', cmd => {
    expect(isSafeTaskCommand(cmd)).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 1, {}, ['npm test']]) expect(isSafeTaskCommand(v)).toBe(false);
  });

  it('accepts up to 8 segments', () => {
    expect(isSafeTaskCommand(Array.from({ length: 8 }, () => 'git status').join(' && '))).toBe(true);
  });

  const REVIEWER_ALLOWED = [
    'npm test', 'npm run test', 'npm t', 'pnpm test', 'yarn test', 'node --test test/a.test.js', 'npm test -- --run',
    'git status', 'git diff HEAD~1', 'git log --oneline -5', 'git show HEAD:src/a.js',
    'npm test && git status && git diff',
  ];
  const REVIEWER_REJECTED = [
    'git add .', 'git commit -m "x"', 'mkdir -p src', 'mkdir src', 'ls', 'pwd',
    'npm test && git commit -m "x"', 'git status && mkdir x', 'npm test 2>&1 | tail -15',
  ];

  it.each(REVIEWER_ALLOWED)('reviewer scope allows %j', cmd => {
    expect(isSafeTaskCommand(cmd, 'reviewer')).toBe(true);
  });

  it.each(REVIEWER_REJECTED)('reviewer scope rejects %j', cmd => {
    expect(isSafeTaskCommand(cmd, 'reviewer')).toBe(false);
  });

  it('reviewer roles get the reviewer scope, every other role the task scope', () => {
    expect(safeScopeFor('spec-reviewer')).toBe('reviewer');
    expect(safeScopeFor('code-reviewer')).toBe('reviewer');
    for (const r of ['implementer', 'test-author', 'debugger', 'qa', 'architect', 'designer', 'researcher']) {
      expect(safeScopeFor(r)).toBe('task');
    }
  });
});

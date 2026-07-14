# Task 2 report

## RED: corrected default expectation

Command:

```powershell
npm run build
node --test dist/test/ccr-v3-adapter.test.js
```

Result: build passed; adapter test failed as expected: 5 passed, 1 failed. The connection assertion actual was `http://127.0.0.1:3456`; expected was `http://127.0.0.1:3457`.

## GREEN: corrected default

Command:

```powershell
npm run build
node --test dist/test/ccr-v3-adapter.test.js
```

Result: build passed; all adapter tests passed (6/6).

## RED: runtime and persisted port precedence

Command:

```powershell
npm run build
node --test dist/test/ccr-v3-adapter.test.js
```

Result: build passed; 6 passed, 2 failed. The generated runtime-port assertion actual was `http://127.0.0.1:3457`; expected was `http://127.0.0.1:4567`. The persisted `PORT` assertion actual was `http://127.0.0.1:3457`; expected was `http://127.0.0.1:4569`.

## GREEN: runtime-first port resolution

Command:

```powershell
npm run build
node --test dist/test/ccr-v3-adapter.test.js
```

Result: build passed; all adapter tests passed (8/8).

## GREEN: focused regression

Command:

```powershell
npm run build
node --test dist/test/paths.test.js dist/test/ccr-v3-adapter.test.js
```

Result: build passed; all focused tests passed (13/13). Errors asserted by the new validation tests contain no configuration or secret-bearing values.

## Full regression

Command:

```powershell
npm test
```

Result: 106/107 tests passed. The sole failure is out of Task 2 ownership: `test/shim-main-options.test.ts` still expects `http://127.0.0.1:3456` while the corrected adapter returns `http://127.0.0.1:3457`.

All Node test commands were run outside the sandbox after the sandboxed test runner failed with `spawn EPERM`.
## Integration: stale shim URL

Command:

```powershell
npm run build
node --test dist/test/shim-main-options.test.js dist/test/paths.test.js dist/test/ccr-v3-adapter.test.js
```

Result: build passed; focused shim, path, and adapter tests passed (15/15).
The tests were run outside the sandbox because the recorded sandboxed Node runner failed with `spawn EPERM`.

Command:

```powershell
npm test
```

Result: full suite passed (107/107 tests, 0 failures).

Command:

```powershell
git diff --check
```

Result: no whitespace errors.

## Review follow-up: gateway port precedence coverage

### Characterization/regression tests

Reviewer-requested tests were added before production changes. They passed immediately against the existing runtime-first implementation, so no real behavioral defect produced a RED and no production code was changed.

Command:

```powershell
npm run build
node --test dist/test/paths.test.js dist/test/ccr-v3-adapter.test.js dist/test/shim-main-options.test.js
```

Result: build passed; the focused path, adapter, and shim set passed (19/19). The added tests prove runtime configuration overrides conflicting `gateway.port`/`PORT`/`routerEndpoint`, persisted precedence is `gateway.port` > `PORT` > `routerEndpoint`, invalid runtime bounds fail validation, unreadable runtime configuration reports a sanitized error, and `start()` checks health at the runtime port.

### Full regression

Command:

```powershell
npm test
```

Result: full suite passed (111/111 tests, 0 failures). Node tests ran outside the sandbox because its worker spawning is blocked with `spawn EPERM`.

No production files changed in this review follow-up.

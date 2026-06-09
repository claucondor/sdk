# openjanus-sdk inventory (2026-06-08)

## Summary

- Total files in scope (src/ + root + tests/ + docs/ + scripts/, excl. dist/, node_modules/): 93
- **PRODUCTION**: 80 (all src/ files + test suite + root build files + circuits + tarball-included docs)
- **PENDING**: 4 (docs/ ARCHITECTURE + EXTENDING + e2e-multitoken script + 1 uncommitted src change)
- **HISTORICAL**: 1 (docs/API.md — v0.4-era class API, fully superseded)
- **DELETE**: 8 (3 result JSONs + 2 repro scripts with hardcoded testnet privkeys + 3 stale tarballs)
- **PENDING REVIEW** (uncommitted): 6 (cadence-scanner.ts + CHANGELOG + README + 3 docs)

---

## Tarball vs source comparison

| Campo | Valor |
|-------|-------|
| Tarball de producción (deployed) | `/home/oydual3/zkapps/private-tip-v1/web/claucondor-sdk-0.7.5.tgz` |
| Hash MD5 del tarball deployed | `cf73f6135e5a2e5b963c65892b59d417` |
| Hash MD5 del tarball en SDK root | `5075645c649d7fb4608ca4835f4d6650` (**DIFERENTE**) |
| Fecha tarball deployed | Jun 8, reconstruido por Vercel — ref. fjw6oc1ta |
| Version en package.json local | 0.7.5 |

### ALERTA CRITICA: Dos tarballs 0.7.5 con contenido diferente

El archivo `/home/oydual3/openjanus-sdk/claucondor-sdk-0.7.5.tgz` fue reconstruido
localmente DESPUES del cambio `DEFAULT_LOOKBACK 100k→5k` sin incrementar version.
Resultado: hay dos archivos con el mismo nombre `claucondor-sdk-0.7.5.tgz` cuyo contenido difiere:

- **Deployed (canonical)**: `DEFAULT_LOOKBACK = 1e5` (100,000 bloques)
- **SDK root rebuild**: `DEFAULT_LOOKBACK = 5e3` (5,000 bloques) — pendiente de subir

El local `dist/` actual también tiene `DEFAULT_LOOKBACK = 5e3`, alineado con el rebuild local
y NO con el tarball deployed. El dist/ local NO debe usarse como referencia de producción.

### Files en tarball NO en src/

Ninguno. Todo lo que está en el tarball proviene de src/ o de assets declarados en package.json
(`circuits/`, `dist/`, `CHANGELOG.md`, `README.md`, `LICENSE`).

### Files en src/ NO en tarball

Todos los src/ files están en el tarball (via dist/). Los siguientes son **sólo compile-time**
y no generan runtime artifacts propios (correcto por diseño):

- `src/declarations.d.ts` — type declarations para snarkjs/circomlibjs/@onflow/*
- `src/adapters/JanusTokenAdapter.ts` — tipo puro; aparece en `.d.ts` del dist como type
- `src/types/proof.ts` — tipos puros; mapeado como `dist/proof-1w0IGRTV.d.ts`
- `src/*/index.ts` (8 barrel files) — entry points de tsup, inlined en cada bundle

---

## Detail per directory

### src/ — 46 archivos

**Todos son PRODUCTION.** Verificado via source maps de los 8 bundles del dist.

#### src/adapters/

| File | Verdict | Razón |
|------|---------|-------|
| `JanusTokenAdapter.ts` | PRODUCTION | Interface exportada en index.ts + adapters/index.ts; aparece en dist .d.ts |
| `index.ts` | PRODUCTION | Entry point tsup `adapters/index` |
| `janus-erc20.ts` | PRODUCTION | Confirmado en source maps de adapters/ y index bundles |
| `janus-flow.ts` | PRODUCTION | Confirmado en source maps de adapters/ y index bundles |
| `janus-ft.ts` | PRODUCTION | Confirmado en source maps de adapters/ y index bundles |

#### src/crypto/

| File | Verdict | Razón |
|------|---------|-------|
| `amount-disclose.ts` | PRODUCTION | En crypto/, orchestration/, adapters/, index bundles |
| `babyjub-keypair.ts` | PRODUCTION | En scan/, crypto/, orchestration/, adapters/, index bundles |
| `babyjub-utils.ts` | PRODUCTION | En scan/, crypto/ bundles |
| `commitment.ts` | PRODUCTION | En crypto/, orchestration/ bundles |
| `decrypt-any-note.ts` | PRODUCTION | En crypto/, index bundles |
| `decrypt-text.ts` | PRODUCTION | En scan/, crypto/, orchestration/, adapters/, index bundles |
| `derive-keypair.ts` | PRODUCTION | En crypto/, index bundles |
| `encrypt-text.ts` | PRODUCTION | En scan/, crypto/, orchestration/, adapters/, index bundles |
| `fee-math.ts` | PRODUCTION | En index bundle; exportado explicitamente en src/index.ts |
| `index.ts` | PRODUCTION | Barrel entry point tsup `crypto/index` |
| `memokey.ts` | PRODUCTION | En index bundle |
| `note-schema.ts` | PRODUCTION | En crypto/, orchestration/, adapters/, index bundles |
| `shielded-note.ts` | PRODUCTION | En crypto/, adapters/, index bundles |
| `shielded-transfer.ts` | PRODUCTION | En orchestration/ source map (via crypto dep chain) |
| `snapshot-schema.ts` | PRODUCTION | En scan/, crypto/, orchestration/, adapters/, index bundles |

#### src/network/

| File | Verdict | Razón |
|------|---------|-------|
| `coa.ts` | PRODUCTION | En network/, adapters/, index bundles |
| `contracts.ts` | PRODUCTION | En scan/, network/, adapters/, index bundles |
| `flow-client.ts` | PRODUCTION | En network/, index bundles |
| `index.ts` | PRODUCTION | Barrel entry point tsup `network/index` |

#### src/orchestration/

| File | Verdict | Razón |
|------|---------|-------|
| `index.ts` | PRODUCTION | Barrel entry point tsup `orchestration/index` |
| `shielded-transfer.ts` | PRODUCTION | En orchestration/, adapters/, index bundles |
| `unwrap.ts` | PRODUCTION | En orchestration/, adapters/, index bundles |
| `wrap.ts` | PRODUCTION | En orchestration/, adapters/, index bundles |

#### src/primitives/

| File | Verdict | Razón |
|------|---------|-------|
| `babyjub.ts` | PRODUCTION | En primitives/, index bundles |
| `groth16.ts` | PRODUCTION | En primitives/ bundle |
| `index.ts` | PRODUCTION | Barrel entry point tsup `primitives/index` |
| `pedersen.ts` | PRODUCTION | En primitives/, orchestration/ source maps |

#### src/scan/

| File | Verdict | Razón |
|------|---------|-------|
| `cadence-scanner.ts` | PRODUCTION* | En scan/, adapters/, index bundles. *Ver nota DEFAULT_LOOKBACK |
| `event-scanner.ts` | PRODUCTION | En scan/ bundle |
| `index.ts` | PRODUCTION | Barrel entry point tsup `scan/index` |
| `latest-snapshot.ts` | PRODUCTION | En scan/ bundle |

> **Nota DEFAULT_LOOKBACK**: La version local tiene `DEFAULT_LOOKBACK = 5_000` (edicion sin commit
> de hoy), mientras que el tarball deployed tiene `DEFAULT_LOOKBACK = 1e5` (100,000). El codigo
> local es correcto para legacy users con ventana corta. Requiere `npm pack` + deploy como v0.7.6
> antes de que sea canonical production.

#### src/types/ y src/

| File | Verdict | Razón |
|------|---------|-------|
| `src/types.ts` | PRODUCTION | En index bundle (tipos compartidos) |
| `src/declarations.d.ts` | PRODUCTION | Declaraciones TS para snarkjs/circomlibjs/@onflow — requeridas para compilacion |
| `src/index.ts` | PRODUCTION | Entry point principal tsup |
| `src/types/commitment.ts` | PRODUCTION | En primitives/, index source maps |
| `src/types/index.ts` | PRODUCTION | Barrel que re-exporta commitment + proof types |
| `src/types/proof.ts` | PRODUCTION | Tipos Groth16 puros; mapeado como `dist/proof-1w0IGRTV.d.ts` |

#### src/utils/

| File | Verdict | Razón |
|------|---------|-------|
| `format.ts` | PRODUCTION | En utils/, index bundles |
| `hex.ts` | PRODUCTION | En utils/ bundle |
| `index.ts` | PRODUCTION | Barrel entry point tsup `utils/index` |
| `pi-b-swap.ts` | PRODUCTION | En utils/, primitives/, crypto/, orchestration/, adapters/, index bundles |

---

### Root-level files

| File | Verdict | Razón |
|------|---------|-------|
| `CHANGELOG.md` | PRODUCTION (uncommitted) | En tarball. Version local agrega entrada v0.7.5 — correcta y debe commitearse |
| `README.md` | PRODUCTION (uncommitted) | En tarball. Version local actualiza version y tabla de tokens para v0.7.5 |
| `LICENSE` | PRODUCTION | En tarball |
| `package.json` | PRODUCTION | En tarball |
| `package-lock.json` | PRODUCTION | Necesario para builds reproducibles |
| `tsconfig.json` | PRODUCTION | Build tool |
| `tsup.config.ts` | PRODUCTION | Build tool — define los 8 entry points |
| `vitest.config.ts` | PRODUCTION | Test runner config (no va al tarball, necesario para CI) |
| `circuits/` | PRODUCTION | Identico al tarball (diff = 0). v0.3 final keys + aggregate test keys |
| `dist/` | (excluido del scope) | — |
| `node_modules/` | (excluido del scope) | — |
| `claucondor-sdk-0.7.2.tgz` | DELETE | Build artifact stale. Ya cubierto por `.gitignore (*.tgz)`. Borrar del working tree. |
| `claucondor-sdk-0.7.3.tgz` | DELETE | Idem |
| `claucondor-sdk-0.7.4.tgz` | DELETE | Idem |
| `claucondor-sdk-0.7.5.tgz` | DELETE | Rebuild local con DEFAULT_LOOKBACK=5k — distinto del tarball deployed. Ya gitignored. Borrar del working tree. |

---

### tests/

#### tests/unit/ — 18 archivos

| File | Verdict | Razón |
|------|---------|-------|
| `amount-disclose.unit.test.ts` | PRODUCTION | Test round-trip de buildAmountDiscloseProof |
| `babyjub.unit.test.ts` | PRODUCTION | Test primitivas BabyJubJub |
| `cadence-scanner.test.ts` | PRODUCTION | Test scanCadenceSnapshots / findFirstSnapshotBlock |
| `decrypt-any-note.test.ts` | PRODUCTION | 8 round-trip tests decryptAnyNote (OF-7) |
| `derive-keypair.unit.test.ts` | PRODUCTION | Test deriveBabyJubKeypairFromBytes |
| `ecdh.test.ts` | PRODUCTION | Test ECIES encrypt/decrypt (forward secrecy) |
| `encrypt-text.unit.test.ts` | PRODUCTION | Test encryptText/decryptText |
| `fee-math.test.ts` | PRODUCTION | Test computeNetWrap/computeNetUnwrap |
| `groth16.unit.test.ts` | PRODUCTION | Test prove/verify Groth16 |
| `memokey-derivation.test.ts` | PRODUCTION | Test deriveMemoKeyFromSignature |
| `memokey-vectors.test.ts` | PRODUCTION | Test vectores deterministicos de memokey |
| `note-schema.test.ts` | PRODUCTION | Test encryptNote/decryptNote |
| `pedersen.unit.test.ts` | PRODUCTION | Test Pedersen commitment |
| `pi-b-swap.test.ts` | PRODUCTION | Test applyPiBSwap / evmProofToUint256Array |
| `shielded-transfer.unit.test.ts` | PRODUCTION | Test buildShieldedTransferProof |
| `snapshot-schema.test.ts` | PRODUCTION | Test encryptSnapshot/decryptSnapshot |
| `unwrap-nonce.unit.test.ts` | PRODUCTION | Invariante: nonce debe ser 0n en orchestrateUnwrap |
| `utils.unit.test.ts` | PRODUCTION | Test bigintToHex/hexToBigint/etc. |

#### tests/integration/ — 12 archivos

| File | Verdict | Razón |
|------|---------|-------|
| `babyjub.integration.test.ts` | PRODUCTION | Test babyAddOnChain contra testnet (gated RUN_INTEGRATION) |
| `cross-token-memokey.test.ts` | PRODUCTION | Alice publica memokey — readable en los 4 adapters |
| `forward-secrecy.test.ts` | PRODUCTION | Test forward secrecy en ECIES |
| `gross-net-ordering.test.ts` | PRODUCTION | Test gross→net ordering logic |
| `groth16.integration.test.ts` | PRODUCTION | Test verifyOnChain contra testnet |
| `scan-recovery.test.ts` | PRODUCTION | Test recovery de balance desde eventos on-chain |
| `token-adapter-contract.test.ts` | PRODUCTION | Test shape de cada adapter (4 tokens) |
| `run-live-reads.mjs` | PRODUCTION | Script runner para reads contra testnet (dev tooling) |
| `run-live-writes.mjs` | PRODUCTION | Script runner para writes contra testnet (dev tooling) |
| `live-reads-results.json` | DELETE | Artifact de ejecucion (Jun 3 2026), no tiene valor como fixture |
| `live-writes-results.json` | DELETE | Idem |

#### tests/e2e/ — 3 archivos

| File | Verdict | Razón |
|------|---------|-------|
| `cross-token-tip.test.ts` | PRODUCTION | Track F gate — 4 actors × 3 tokens (gated RUN_E2E) |
| `run-track-f-gate.mjs` | PRODUCTION | Script runner que valida las 5 Track F assertions |
| `cross-token-tip-results.json` | DELETE | Artifact de ejecucion (Jun 3 2026), no es fixture |

---

### docs/ — 3 archivos

> Nota: la carpeta docs/ NO existe en el tarball. Es documentacion de desarrollo.
> Los 3 archivos tienen cambios uncommitted hoy (solo renombre @openjanus → @claucondor).

| File | Verdict | Razón |
|------|---------|-------|
| `docs/API.md` | HISTORICAL | API obsoleta (v0.4-era): expone `JanusToken`, `JanusFlow` como clases, `@claucondor/sdk/tokens`, etc. Ninguno de estos exports existe en v0.6+. El cambio de hoy solo renombro el package — el contenido sigue siendo incorrecto. Mover a `_archive/`. |
| `docs/ARCHITECTURE.md` | PENDING | Describe correctamente el modelo 4-capas (adapters/orchestration/crypto/network) de v0.6.0. Los code examples usan `JanusFlow` (viejo) pero la arquitectura conceptual es valida. Queda en main con nota de que los ejemplos necesitan update. |
| `docs/EXTENDING.md` | PENDING | Guia de extension de modulos — patron arquitectural valido. Code examples tienen nombres de paquete correcto post-fix de hoy. Queda en main. |

---

### scripts/ — 3 archivos

| File | Verdict | Razón |
|------|---------|-------|
| `scripts/repro-recovery.mjs` | DELETE | Script de reproduccion one-time para bug MockFT recovery (ya resuelto). **ALERTA: Contiene `MEMO_PRIVKEY = 880413...182n` hardcodeado** — clave privada BabyJub de testnet del operator. No deberia quedar en el repo aunque sea testnet. Borrar. |
| `scripts/repro-firstsnapshot-recovery.mjs` | DELETE | Idem — script one-time para FirstSnapshot scan logic. Mismo `MEMO_PRIVKEY` hardcodeado. Borrar. |
| `scripts/e2e-multitoken.mjs` | PENDING | Script E2E completo (3 tokens × 2 recipients, proofs reales). Mas granular que el Vitest E2E test. Util para pre-deploy smoke testing. Queda en main o en feature branch segun preferencia operator. |

---

## Uncommitted changes triage (6 archivos modificados)

| File | Decision | Notas |
|------|----------|-------|
| `CHANGELOG.md` | PRODUCTION — commitear | Agrega entrada v0.7.5 correcta. No estaba en tarball deployed porque el tarball se generó antes de este edit. Commitear como parte de v0.7.5 cleanup o como prefijo de v0.7.6. |
| `README.md` | PRODUCTION — commitear | Actualiza version badge a v0.7.5 y tabla de tokens (mockft agregado, wflow removido del TOKEN_REGISTRY activo). Correcto. |
| `docs/API.md` | HISTORICAL — commitear el rename, luego archivar | El diff de hoy es solo `@openjanus → @claucondor`. El cuerpo sigue siendo v0.4-era. Commitear el fix cosmético pero mover a `_archive/docs/API.md` en un segundo commit. |
| `docs/ARCHITECTURE.md` | PENDING — commitear | El diff es solo `@openjanus → @claucondor` en un code snippet. Contenido arquitectural valido. |
| `docs/EXTENDING.md` | PENDING — commitear | Idem, solo rename. |
| `src/scan/cadence-scanner.ts` | PRODUCTION (interim) — commitear con version bump | `DEFAULT_LOOKBACK 100_000 → 5_000` es un fix valido para legacy users cuyo primer wrap fue reciente. Sin embargo: (1) diverge del tarball deployed, (2) hay que buildear y re-publicar como v0.7.6 antes de que sea canonical. **No commitear en aislamiento** — commitear junto con bump de version y rebuild del tarball. |

---

## Action plan

### Archivos que permanecen en main (no action needed)

- **46** archivos src/ — todos PRODUCTION, no tocar
- **28** archivos tests/ — unit + integration + e2e + runners (menos los 3 JSONs)
- **2** archivos docs/ — ARCHITECTURE.md + EXTENDING.md (PENDING, quedan en main)
- **1** script — scripts/e2e-multitoken.mjs (PENDING, queda en main)
- Root: CHANGELOG.md, README.md, LICENSE, package.json, package-lock.json, tsconfig.json, tsup.config.ts, vitest.config.ts, circuits/

### Archivos a eliminar (8 archivos)

```bash
# Result JSONs — artifacts de ejecucion sin valor como fixtures
rm tests/integration/live-reads-results.json
rm tests/integration/live-writes-results.json
rm tests/e2e/cross-token-tip-results.json

# Repro scripts — one-time, contienen privkey de testnet hardcodeada
rm scripts/repro-recovery.mjs
rm scripts/repro-firstsnapshot-recovery.mjs

# Stale tarballs en root del repo — ya gitignored, solo limpiar working tree
rm claucondor-sdk-0.7.2.tgz
rm claucondor-sdk-0.7.3.tgz
rm claucondor-sdk-0.7.4.tgz
# No borrar claucondor-sdk-0.7.5.tgz del SDK root todavia — ver open questions
```

### Archivos a archivar (1 archivo)

```bash
mkdir -p _archive/docs
mv docs/API.md _archive/docs/API-v0.4-era.md
# Agregar nota al inicio: "Este documento describe la API v0.4 (JanusToken class).
#  Desde v0.6, usar sdk.token(id). Ver README.md para API actual."
```

### Commits necesarios

1. **Commit: cleanup artifacts + archive stale docs**
   - Delete 5 files (3 JSONs + 2 repro scripts)
   - Move docs/API.md → _archive/
   - Commit uncommitted docs changes (ARCHITECTURE.md, EXTENDING.md — solo rename cosmético)

2. **Commit: v0.7.5 release notes**
   - CHANGELOG.md + README.md uncommitted changes

3. **Commit: v0.7.6 prep** (requiere build previo)
   - src/scan/cadence-scanner.ts (DEFAULT_LOOKBACK fix)
   - Bump version a 0.7.6 en package.json
   - Rebuild: `npm run build && npm pack`
   - Copiar nuevo tgz a /home/oydual3/zkapps/private-tip-v1/web/

---

## Open questions para el operator

1. **Tarball local vs deployed**: El tarball en `/home/oydual3/openjanus-sdk/claucondor-sdk-0.7.5.tgz`
   tiene DEFAULT_LOOKBACK=5k (ya incluye el fix) pero el nombre sigue siendo 0.7.5 igual que el
   deployed (que tiene DEFAULT_LOOKBACK=100k). ¿Conviene subir el fix como v0.7.6 o como hotfix
   directo al 0.7.5 deployed? La memoria SDK publish discipline requiere browser-tested antes de
   `npm publish`, pero el deploy via tgz es independiente.

2. **`wflow` en TOKEN_REGISTRY**: El README.md local (uncommitted) removio `wflow` del listado
   visible pero el TOKEN_REGISTRY en `src/network/contracts.ts` puede seguir teniendo `wflow`.
   ¿Fue removido de contracts.ts también? (No se modifico hoy segun git diff.)

3. **docs/API.md**: ¿Quiere el operator que se escriba una nueva API.md reflejo del v0.7.5 actual
   (sdk.token / adapters / orchestration exports) o con mantener ARCHITECTURE.md + README.md como
   referencia principal es suficiente por ahora?

4. **scripts/e2e-multitoken.mjs**: ¿Queda en main como smoke test script, o se mueve a una
   feature branch de QA? El script referencia `dist/index.js` directamente (no src/), asi que
   requiere `npm run build` previo para usarse.

5. **Privkeys en repro scripts**: Confirmar que `MEMO_PRIVKEY = 880413913145503288287847458865894980663156109874655634189442181344760966182n`
   es una clave de testnet descartable y no reutilizada en produccion. Si se reutiliza, rotar.

# Opening prompt: implement the opencode2dsh agent

Usage: paste this entire file as a single standalone message to a coding agent (or subagent) that does NOT share this conversation's context. It is self-contained: all prior research conclusions live in the documents referenced below. The agent should read the docs, read the upstream source, and proceed strictly against the acceptance criteria. Do not fabricate facts.

.

## Your role and constraints

You are the opencode2dsh implementation engineer. Goal: turn the design doc and plan doc into compiling, acceptance-passing code..

.

Hard constraints:

1. Read-only ground truth. The following are your sources of truth. Any "common sense" that conflicts with them loses; when unsure, re-read the source:
   - Design doc: D:\codes\dshPlugins\opencode2dsh\docs\design.md
   - Plan doc: D:\codes\dshPlugins\opencode2dsh\docs\plan.md (phases, acceptance commands, commit granularity per plan.md)
   - Upstream source (read-only, DO NOT modify): all .go files under C:\Users\FishBottle\AppData\Local\Temp\opencode\opencode2api\  (Go 1.24, single package main)
2. Copy-then-freeze (plan.md general principle 1): copied code from opencode2api must run with its original semantics first, then be trimmed piece by piece; after every trim, must pass go build ./... and go test ./....
3. Do only what the docs allow: items marked "do NOT port" in design.md section 5 (admin.go, webui/, password.go, runtime.go hot-reload) must not be touched; items marked "trim but keep interface" follow design.md section  ���6.3 (cross-protocol conversion: leave interface stubs only).
4. Fill in missing context yourself: you did not see the discussion before this prompt. design.md is authoritative; each phase's acceptance criteria in plan.md IS your definition of done (command passing = phase complete).

##Tool usage rules

- Use the read tool for docs/source (with line numbers); do not cat text files with shell.
- Use glob/grep to locate files and anchors. Note: line numbers may drift after porting; trust function names + semantics, treat design.md's file:line anchors as locating hints.
..
- All writes confined to D:\codes\dshPlugins\opencode2dsh\.
- After each file edit, say in one line: what you changed, and which anchor it is based on..

##Overall route (detail in plan.md)

Proceed Phase0 to Phase3 in order. Phase0 is the biggest risk cluster (upstream anonymous reachability + S3 static-list calibration); do it first, conclude within a day, do not procrastinate from 0.1 through 0.9:

1. Phase0 risk pre-check (about half a day): do not build the full port yet. Use the original opencode2api binary directly: if Go toolchain present, cd C:\Users\FishBottle\AppData\Local\Temp\opencode\opencode2api and run go build; start it with a temp config.json (see design.md section8.3 template: listen=127.0.0.1:<temporary-port>, server_keys=["dev"], anonymous:true, empty zen/go keys). Then run plan.md Phase0 acceptance steps 3/5/6;  i.e. curl /v1/models, plus one anonymous chat non-streaming and one streaming. Deliverable: record the actually-working model ids into your report's "S3 candidate list".
   - Ifthe Phase0 pre-check fails (e.g. current IP rate-limited): DO NOT redesign on your own. Record the symptom, attach the curl HTTP status code and body, stop at Phase0且 report, wait for a human ruling (postponement, network change, or enabling the self-hosting proxy switch per design.md section9.2).
2. Phase0 full port ( plan.md 0.1-0.9 order): build agent/ Go module (cmd/agent + internal/*, zero third-party depenps), port in plan.md task order: ids / config / catalog (metadata + static_models.go S3) → pool → convert/obs → gateway → main; each unit passes its unit test.

   - Fill S3 static_models.go with the model ids verified in step1 (each entry annotated with the verification date).
   - Phase0 acceptance: run plan.md 0.10's 7 commands one by one (Windows binary name is agent.exe;; all pass = done.
 via
3. Phase1 DSH plugin integration:– step (1.1: read DSH-side provider-registration code/docs, answer open question Q1(whether the plugin can dynamically inject a provider and model list: write the conclusion into plan.md appendix); it decides whether provider.ts is "runtime injection" or "generates a config snippet + prompt user to restart DSH"..
   - Then implement in order: --print-ready(1.2: the only NEW logic vs opencode2api, about20 lines)、agent-process.ts (spawn/health-readiness/READY handshake/exponential-backoff restart，plan.md 1.3)、config.ts (token generation + persistence, 0600 perms, plan.md 1.4)、provider.ts(1.5)、lifecycle wiring(1.6)。
   - Acceptance: plan.md Phase1's 5 criteria,, with "no orphan process", "crash auto-recovery", "offline does not hang" mandatory to verify……
4. Phase2 (dynamic model sync + S3 calibration script) and Phase3(retry/error-mapping/optional proxy): may run in parallel with Phase1;; acceptance per plan.md sections2.1-2.5 and3.1-3.6. The"gray-capability" proxy pool must stay default ["direct"] OFF, and the npm distribution must contain no multi-proxy examples (design.md section9.2).
5. Wrap-up: go test ./... and plugin tests all green;; per plan.md deliverables list, produce packages/plugin, packages/agent-bin-*(5-platform cross-compile workflow) and README.md (with the honest "limits and compliance" statement); in your final summary, list: phases done / not done + reason + next step..​​​​
.

.

##Report format (output one at each phase close)

```
[Phase N: done/blocked]
- What was done: <one ported unit per line, with source file≥>
- Acceptance command results: <per-command: pass / fail(status+phenomenon)>>
- S3 candidate list (at Phase0): <verified model ids ia list>
- Blockers(if any): <phenomenon + evidence read + the ruling you need>
- Next step:<the single immediate action>
```

##Key-facts cheat-sheet(anchors already verified per design.md sections2.4 and5: no need to re-verify)

- Anonymous credential: Authorization: Bearer public (gateway.go:20 anonymousZenKey)。
- Upstream endpoint: https://opencode.ai/zen (config.go:85;)。Chat path: /v1/chat/completions (protocolPath,gateway.go:789)。
- Request headers: x-opencode-client: cli, x-opencode-session / x-session-affinity / X-Session-Id, x-opencode-request, x-opencode-project, User-Agent: opencode/1.18.21 (...) -- all in gateway.go:640-669.
- Free determination: models.dev cost==0 and not deprecated,, or name contains "free" (model_metadata.go:192 Decide)。
- Free-model-list 3 sources: S1 dynamic GET /v1/models (Bearer public) → S2 models.dev determination → S3 compile-time static list (calibrated plan.md 0.10。
- config validation naturally allows"anonymous:true + empty zen/go keys + server_keys with at least one"(config.go:131-133) — keep that combination when porting
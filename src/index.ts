interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Pulse Verity — crypto index prices that come with a PROOF.
 *
 * Every other price source in this catalogue hands back a number you have to
 * take on trust. Pulse signs each observation with ECDSA P-256 over a canonical
 * string, so an agent that acted on a price can later demonstrate WHICH price it
 * acted on, and that demonstration holds with the agent, this gateway and Pulse
 * all offline. That is the reason this pack exists; the price is the vehicle.
 *
 * ── DO NOT STRIP THE SIGNATURE TO TIDY THE PAYLOAD ──────────────────────
 *
 * `signature`, `kid` and `sig` travel on every print we return. They look like
 * noise next to a price and they are the product. A caller that receives the
 * number without them has the same thing every other pack gives it.
 *
 * ── THE priceText TRAP, MEASURED ────────────────────────────────────────
 *
 * The canonical string is built from `priceText` — the price EXACTLY as it
 * appeared on the wire — never from a reparsed float. On the sample used while
 * building this, `String(price)` happened to equal `priceText`, so a
 * float-reparsing verifier VERIFIED CORRECTLY and looked right. It breaks the
 * first time JS number formatting diverges from the wire text: a trailing zero
 * ("76051.10" vs 76051.1), exponent form (1e-7), or more than 17 significant
 * digits. A verifier that is correct only until the price has a trailing zero is
 * worse than none, because it will be trusted.
 *
 * So: `canonicalString()` below prefers priceText and falls back to
 * String(price) ONLY when priceText is absent, which is the fallback Pulse's own
 * verifier documents. When we fall back, the response says so.
 *
 * ── GRADES ARE LOAD-BEARING, NOT METADATA ───────────────────────────────
 *
 *   consensus  — 3+ independent venues
 *   blended    — 2 venues
 *   indicative — ONE exact-mapped venue. NEVER valid for settlement.
 *
 * A thin asset comes back marked `indicative` rather than confidently wrong,
 * which is the honest behaviour we want from an upstream — and it is only
 * honest downstream if we carry the grade through and say what it means. Every
 * print we return therefore also carries `settleable` (a boolean we derive) and
 * `grade_note`, because an agent reading a bare price field will not infer that
 * `indicative` disqualifies it.
 *
 * ── WHAT IS SIGNED AND WHAT IS NOT ──────────────────────────────────────
 *
 * Prints (`/price`, `/batch`, `/print`) are signed. The asset CATALOGUE is NOT:
 * its rows carry prices and coverage metadata with no signature, and Pulse says
 * to re-read the number through a print tool if you need a verifiable one. So
 * `pulse_asset_catalog` marks itself `signed: false` and says that in the tool
 * description. Serving an unsigned price from a pack whose whole pitch is
 * signatures is exactly the confusion worth pre-empting.
 */


const API_BASE = 'https://mcp.thepulse.markets/api/index/v1';
const UA = 'pipeworx-mcp-pulse-verity/1.0 (+https://pipeworx.io)';
const SOURCE = 'Pulse Verity Index (thepulse.markets)';
const MAX_BATCH = 100;

const GRADE_NOTES: Record<string, string> = {
  consensus: 'consensus: 3 or more independent venues agreed. Valid for settlement.',
  blended: 'blended: 2 independent venues. Valid for settlement, with a wider interval than consensus.',
  indicative:
    'indicative: ONE exact-mapped venue. NOT valid for settlement — Pulse publishes it so a thin asset reads as thin instead of confidently wrong. Use it as a sighting, never as a price to settle against.',
};

/** Grades Pulse states are settleable. Unknown grades are treated as NOT settleable. */
const SETTLEABLE = new Set(['consensus', 'blended']);

function gradeFields(grade: unknown) {
  const g = typeof grade === 'string' ? grade : '';
  return {
    settleable: SETTLEABLE.has(g),
    grade_note:
      GRADE_NOTES[g] ??
      `unrecognised grade ${JSON.stringify(grade)} — treated as NOT settleable, because a grade this pack has never seen cannot be asserted to be safe. Check /pubkey's notes and this pack's README.`,
  };
}

// ── canonical string ────────────────────────────────────────────────────

export interface SignedPrint {
  symbol: string;
  price?: number;
  priceText?: string;
  at: string;
  grade: string;
  signature: string;
  kid?: string;
  sig?: string;
}

/**
 * Rebuild the exact bytes Pulse signed: `pulse-index-v1\n{symbol}\n{price}\n{at}\n{grade}`.
 * Returns the string plus whether the priceText fallback was used, so the
 * caller can be told rather than silently trusting a reparsed float.
 */
export function canonicalString(p: SignedPrint): { canonical: string; usedFallback: boolean } {
  const hasText = typeof p.priceText === 'string' && p.priceText.length > 0;
  const priceField = hasText ? (p.priceText as string) : String(p.price);
  return {
    canonical: `pulse-index-v1\n${p.symbol}\n${priceField}\n${p.at}\n${p.grade}`,
    usedFallback: !hasText,
  };
}

// ── key ring ────────────────────────────────────────────────────────────

interface RingKey { kid: string; jwk: JsonWebKey; active?: boolean }
interface KeyRing { algorithm?: string; canonical?: string; activeKid?: string; verificationKeys: RingKey[] }

/**
 * Module-scope ring cache, keyed by kid.
 *
 * WHY A CACHE AND NOT AN EMBEDDED CONSTANT. Hard-coding today's public key
 * would make verification need no network at all, and would silently start
 * REJECTING VALID PRINTS the day Pulse rotates its key — a signature failure
 * that reads as "Pulse is lying to you" when the truth is that the key it was
 * checked against had simply expired. That is the worst possible direction for
 * this pack's error to point.
 *
 * WHY THE CACHE IS STILL HONEST ABOUT "LOCAL". The ECDSA verification is local:
 * we never ask Pulse whether a print is valid, so Pulse cannot answer "yes"
 * about a print it never signed, and a compromised or offline Pulse cannot turn
 * an invalid print into a valid one. What is not local is KEY DISTRIBUTION — a
 * kid we have never seen costs one fetch of the public ring. Every response
 * says which of the two happened in `key_source`, because "verified locally" is
 * a security claim and a pack should not make it vaguely.
 */
const ringCache = new Map<string, CryptoKey>();
let ringMeta: { algorithm?: string; activeKid?: string; fetchedAt?: string } = {};

async function fetchRing(): Promise<KeyRing> {
  const res = await fetchWithTimeout(
    `${API_BASE}/pubkey`,
    { headers: { Accept: 'application/json', 'User-Agent': UA } },
    'Pulse Verity key ring',
  );
  const text = await res.text();
  if (!res.ok) throw pulseError(res.status, text, 'pulse_key_ring');
  let body: KeyRing;
  try {
    body = JSON.parse(text) as KeyRing;
  } catch {
    throw new Error(
      `pulse_key_ring: Pulse's key ring was not JSON (HTTP ${res.status}). Without the ring no signature can be checked, so this fails rather than returning an unverified print. Upstream said: ${summarizeErrorBody(text)}`,
    );
  }
  if (!Array.isArray(body.verificationKeys) || body.verificationKeys.length === 0) {
    throw new Error('pulse_key_ring: the ring came back with no verification keys, so nothing can be verified against it.');
  }
  ringMeta = { algorithm: body.algorithm, activeKid: body.activeKid, fetchedAt: new Date().toISOString() };
  return body;
}

async function keyFor(kid: string | undefined): Promise<{ key: CryptoKey; source: 'cache' | 'fetched'; kid: string }> {
  const wanted = kid && kid.length > 0 ? kid : undefined;
  if (wanted) {
    const hit = ringCache.get(wanted);
    if (hit) return { key: hit, source: 'cache', kid: wanted };
  }
  const ring = await fetchRing();
  for (const entry of ring.verificationKeys) {
    if (!entry?.kid || !entry?.jwk) continue;
    try {
      const k = await crypto.subtle.importKey(
        'jwk',
        { ...(entry.jwk as JsonWebKey), ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      ringCache.set(entry.kid, k);
    } catch {
      /* a ring entry we cannot import is skipped, not fatal: the kid we need may still be there */
    }
  }
  const chosenKid = wanted ?? ring.activeKid ?? ring.verificationKeys[0]?.kid;
  const key = chosenKid ? ringCache.get(chosenKid) : undefined;
  if (!key || !chosenKid) {
    throw new Error(
      `pulse_verify_print: no public key in Pulse's ring matches kid ${JSON.stringify(kid)}. The ring currently holds ${[...ringCache.keys()].join(', ') || '(nothing importable)'}. A print whose kid is absent from the ring cannot be verified — treat it as UNVERIFIED, not as invalid.`,
    );
  }
  return { key, source: 'fetched', kid: chosenKid };
}

// ── verification ────────────────────────────────────────────────────────

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyPrint(args: Record<string, unknown>) {
  const p = args as unknown as SignedPrint;
  for (const f of ['symbol', 'at', 'grade', 'signature'] as const) {
    if (typeof p[f] !== 'string' || !(p[f] as string).length) {
      throw new Error(
        `pulse_verify_print requires ${f}. Pass the print back EXACTLY as a Pulse tool returned it — symbol, price, priceText, at, grade, signature and kid. Re-typing or rounding any field will make a genuine print fail to verify.`,
      );
    }
  }
  if (typeof p.priceText !== 'string' && typeof p.price !== 'number') {
    throw new Error(
      'pulse_verify_print requires priceText (preferred) or price. priceText is the price exactly as Pulse served it and is what was signed.',
    );
  }

  const { canonical, usedFallback } = canonicalString(p);
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64ToBytes(p.signature);
  } catch {
    throw new Error('pulse_verify_print: signature is not valid base64, so it cannot be a Pulse signature. Pass it exactly as returned.');
  }

  const { key, source, kid } = await keyFor(p.kid);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigBytes, new TextEncoder().encode(canonical));

  return {
    valid,
    symbol: p.symbol,
    at: p.at,
    grade: p.grade,
    ...gradeFields(p.grade),
    kid_used: kid,
    key_source: source === 'cache'
      ? 'cached public key — this verification made NO network call of any kind'
      : "fetched Pulse's public key ring once for this kid, then verified locally; the ring is cached for subsequent calls",
    signature_bytes: sigBytes.length,
    canonical_string: canonical,
    price_field_used: usedFallback ? 'String(price) — priceText was absent' : 'priceText, verbatim',
    ...(usedFallback
      ? {
          fallback_warning:
            'priceText was not supplied, so the canonical string was rebuilt from String(price). That matches Pulse\'s documented fallback and is usually right, but JS float formatting can differ from the wire text (trailing zeros, exponent form, >17 significant digits) and would make a GENUINE print fail here. Pass priceText when you have it.',
        }
      : {}),
    verification:
      'ECDSA P-256 / SHA-256 over `pulse-index-v1\\n{symbol}\\n{priceText}\\n{at}\\n{grade}`, signature as IEEE-P1363 r||s, base64. Computed in this worker: Pulse is never asked whether the print is valid, so it cannot vouch for a print it did not sign.',
    ...(valid
      ? {}
      : {
          invalid_note:
            'The signature does NOT match this print. Either a field was altered after signing (a single changed digit, or a 1ms shift in `at`, is enough) or the print did not come from Pulse. Do not settle against it. If you re-typed any field by hand, re-fetch the print and try again before concluding it was tampered with.',
        }),
    source: SOURCE,
  };
}

// ── HTTP ────────────────────────────────────────────────────────────────

function requireKey(apiKey: string | undefined, tool: string): string {
  if (!apiKey) {
    throw new Error(
      `${tool} requires an API key: the Pulse Verity Index refuses unkeyed reads for anything beyond the BTC/ETH/SOL sample. Pass it as _apiKey. A free key is self-serve at https://thepulse.markets/developers (60 requests/minute, 25,000/month, no card).`,
    );
  }
  return apiKey;
}

function pulseError(status: number, bodyText: string, tool: string): Error {
  const upstream = summarizeErrorBody(bodyText);
  const detail = upstream ? ` Upstream said: ${upstream}` : '';
  if (status === 401 || status === 403) {
    return new Error(
      `${tool} requires an API key that Pulse accepts (HTTP ${status}). Get a free one at https://thepulse.markets/developers and pass it as _apiKey.${detail}`,
    );
  }
  if (status === 404) {
    return new Error(
      `${tool}: Pulse does not serve that symbol (HTTP 404). The index covers thousands of assets but not every ticker — call pulse_asset_catalog to see what is covered and at what grade.${detail}`,
    );
  }
  if (status === 429) {
    return new Error(
      `${tool}: rate limited by Pulse (HTTP 429). The free tier is 60 requests/minute and 25,000/month; pause rather than retrying in a loop.${detail}`,
    );
  }
  return new Error(`${tool}: HTTP ${status} from the Pulse Verity Index.${detail}`);
}

async function pulseGet(path: string, apiKey: string | undefined, tool: string, keyed = true): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': UA };
  if (keyed) headers.Authorization = `Bearer ${requireKey(apiKey, tool)}`;
  const res = await fetchWithTimeout(`${API_BASE}${path}`, { headers }, SOURCE);
  const text = await res.text();
  if (!res.ok) throw pulseError(res.status, text, tool);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // A 200 is not a promise of JSON. Never forward the raw body: an upstream
    // HTML error page inside a JSON field makes the caller's whole explanation
    // a parser complaint about the letter '<'.
    throw new Error(`${tool}: Pulse answered HTTP ${res.status} with a body that is not JSON. Upstream said: ${summarizeErrorBody(text)}`);
  }
  // Pulse signals refusals in-band with success:false and a code.
  const b = body as Record<string, unknown>;
  if (b && b.success === false) {
    const code = typeof b.code === 'string' ? ` (${b.code})` : '';
    throw new Error(`${tool}: Pulse refused the request${code}: ${String(b.message ?? 'no message')}`);
  }
  return body;
}

function decorate(print: Record<string, unknown>): Record<string, unknown> {
  return { ...print, ...gradeFields(print.grade) };
}

// ── tools ───────────────────────────────────────────────────────────────

async function signedPrice(args: Record<string, unknown>, apiKey?: string) {
  const symbol = String(args.symbol ?? '').trim();
  if (!symbol) throw new Error('pulse_signed_price requires a symbol, e.g. {"symbol":"BTC"}. pulse_asset_catalog lists what is covered.');
  const body = (await pulseGet(`/price?symbol=${encodeURIComponent(symbol)}`, apiKey, 'pulse_signed_price')) as Record<string, unknown>;
  return {
    print: decorate(body),
    verify_with: 'pulse_verify_print — pass this print back unchanged, including priceText, signature and kid.',
    source: SOURCE,
  };
}

async function signedBatch(args: Record<string, unknown>, apiKey?: string) {
  const raw = args.symbols;
  const list = Array.isArray(raw)
    ? raw.map((s) => String(s).trim()).filter(Boolean)
    : String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error('pulse_signed_batch requires symbols, e.g. {"symbols":["BTC","ETH"]}.');
  if (list.length > MAX_BATCH) {
    throw new Error(`pulse_signed_batch takes at most ${MAX_BATCH} symbols per call (${list.length} given); your API tier may allow fewer. Split the list rather than dropping symbols silently.`);
  }
  const body = (await pulseGet(`/batch?symbols=${encodeURIComponent(list.join(','))}`, apiKey, 'pulse_signed_batch')) as Record<string, unknown>;
  const obs = Array.isArray(body.observations) ? (body.observations as Record<string, unknown>[]) : [];
  const returned = obs.filter((o) => o?.success !== false).map(decorate);
  const returnedSymbols = new Set(returned.map((o) => String(o.symbol)));
  // Pulse returns FEWER rows than requested for symbols it does not serve, and
  // the missing ones are simply absent. Reporting a short list as the answer is
  // a silent partial: name what did not come back.
  const missing = list.filter((s) => !returnedSymbols.has(s));
  return {
    requested: list.length,
    returned: returned.length,
    observations: returned,
    ...(missing.length
      ? {
          not_served: missing,
          not_served_note: `Pulse returned no print for ${missing.length} of the ${list.length} symbols requested. They are absent from the response rather than reported as errors, so they are listed here explicitly — an unlisted symbol is NOT a price of zero. Check pulse_asset_catalog for coverage.`,
        }
      : {}),
    each_row_signed: 'Every observation is individually signed and can be checked on its own with pulse_verify_print.',
    source: SOURCE,
  };
}

async function settlementPrint(args: Record<string, unknown>, apiKey?: string) {
  const symbol = String(args.symbol ?? '').trim();
  const at = String(args.at ?? '').trim();
  if (!symbol || !at) {
    throw new Error('pulse_settlement_print requires symbol and at, e.g. {"symbol":"BTC","at":"2026-09-16T21:41:46.000Z"}. `at` accepts ISO-8601 or epoch milliseconds.');
  }
  const body = (await pulseGet(
    `/print?symbol=${encodeURIComponent(symbol)}&at=${encodeURIComponent(at)}`,
    apiKey,
    'pulse_settlement_print',
  )) as Record<string, unknown>;
  const deltaMs = typeof body.deltaMs === 'number' ? body.deltaMs : null;
  return {
    print: decorate(body),
    requested_at: at,
    delta_ms: deltaMs,
    delta_note:
      deltaMs === null
        ? 'Pulse did not report deltaMs for this print, so how far it sits from the time you asked for is unknown — do not assume it is exact.'
        : `The print returned is the recorded observation NEAREST your requested time, ${deltaMs} ms away — it is not a print AT that instant. For a settlement, state the tolerance you accept and check this number against it.`,
    source: SOURCE,
  };
}

async function assetCatalog(args: Record<string, unknown>, apiKey?: string) {
  const q = new URLSearchParams();
  const limit = Number(args.limit ?? 50);
  q.set('limit', String(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50));
  if (args.offset !== undefined) q.set('offset', String(args.offset));
  if (args.band) q.set('band', String(args.band));
  if (args.status) q.set('status', String(args.status));
  const body = (await pulseGet(`/verity/catalog?${q.toString()}`, apiKey, 'pulse_asset_catalog')) as Record<string, unknown>;
  return {
    ...body,
    signed: false,
    signed_note:
      'CATALOGUE ROWS ARE NOT SIGNED. The prices and coverage metadata here carry no signature and must not be settled against. If you need a verifiable number for one of these symbols, read it through pulse_signed_price and check it with pulse_verify_print.',
    source: SOURCE,
  };
}

async function keyRing(_args: Record<string, unknown>) {
  const ring = (await pulseGet('/pubkey', undefined, 'pulse_key_ring', false)) as Record<string, unknown>;
  return {
    ...ring,
    usage:
      'Select the key whose kid matches the print, rebuild `pulse-index-v1\\n{symbol}\\n{priceText}\\n{at}\\n{grade}` using priceText VERBATIM, then ECDSA P-256 / SHA-256 verify the base64 IEEE-P1363 signature. pulse_verify_print does all of this for you.',
    keyless: true,
    source: SOURCE,
  };
}

// ── definitions ─────────────────────────────────────────────────────────

const KEY_ARG = {
  type: 'string',
  description: 'Pulse Verity API key. Free and self-serve at https://thepulse.markets/developers (60 req/min, 25,000/month, no card).',
} as const;

const PRINT_NOTE =
  'Each print carries signature, kid, grade, the number of independent venues (sources), dispersion in basis points and a confidence interval. Grades: consensus (3+ venues) and blended (2) are settleable; indicative (1 venue) is NOT.';

const tools: McpToolExport['tools'] = [
  {
    name: 'pulse_signed_price',
    description:
      `The current CRYPTOGRAPHICALLY SIGNED index price for one crypto asset, from the Pulse Verity Index across thousands of assets and dozens of venues — this result carries a signature you can verify: pass it unchanged to pulse_verify_print to check it OFFLINE, with no network call, against Pulse's public key. ${PRINT_NOTE} Use it when a price has to be defensible — settlement, an audit trail, a dispute — not merely current. Requires a Pulse API key via _apiKey. Example: pulse_signed_price({ symbol: "BTC" }).`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Asset ticker as Pulse spells it, e.g. BTC, ETH, SOL. pulse_asset_catalog lists coverage.' },
        _apiKey: KEY_ARG,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'pulse_signed_batch',
    description:
      `Signed index prices for up to 100 crypto assets in ONE call — each row carries its own signature you can verify individually with pulse_verify_print, offline, with no network call, not just the batch as a whole. Use this instead of looping pulse_signed_price: it is one request against the rate limit and every observation still carries its own signature, grade, venue count and interval. Symbols Pulse does not serve come back named in not_served rather than silently missing. Requires a Pulse API key via _apiKey. Example: pulse_signed_batch({ symbols: ["BTC", "ETH", "SOL"] }).`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 100 tickers. A comma-separated string is also accepted.',
        },
        _apiKey: KEY_ARG,
      },
      required: ['symbols'],
    },
  },
  {
    name: 'pulse_settlement_print',
    description:
      `The signed index print Pulse RECORDED nearest a past moment — the tool for settling a contract, pricing an option at expiry, or reconstructing what an asset was worth at a specific timestamp. Returns the observation with its original signature intact — verify it offline with pulse_verify_print, no network call — plus delta_ms, the distance between the time you asked for and the print actually returned; it is the nearest recorded print, never a price synthesised at your exact instant. Accepts ISO-8601 or epoch milliseconds. Requires a Pulse API key via _apiKey. Example: pulse_settlement_print({ symbol: "BTC", at: "2026-09-16T21:41:46.000Z" }).`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Asset ticker, e.g. BTC.' },
        at: { type: 'string', description: 'The moment to price, as ISO-8601 (2026-09-16T21:41:46.000Z) or epoch milliseconds.' },
        _apiKey: KEY_ARG,
      },
      required: ['symbol', 'at'],
    },
  },
  {
    name: 'pulse_verify_print',
    description:
      'Check whether a Pulse signed price print is authentic and unaltered — pass a print back exactly as a Pulse tool returned it and this recomputes the ECDSA P-256 / SHA-256 signature over the canonical string, entirely OFFLINE with no network call to Pulse. WHAT A valid:true RESULT PROVES: that Pulse asserted this exact price, for this symbol, at this timestamp, at this grade, and that nobody altered any of those fields in transit — it detects a single changed digit of price or a one-millisecond shift in the timestamp. WHAT IT DOES NOT PROVE: that the price is CORRECT or reflects the true market — this checks Pulse\'s signature, not the world, so a print can verify perfectly and still be a price Pulse itself got wrong. The verification is computed here, not asked of Pulse, so Pulse cannot vouch for a print it never signed and an offline or compromised source cannot turn an invalid print into a valid one. Needs NO API key. Example: pulse_verify_print({ symbol: "BTC", priceText: "76051.0676303142", price: 76051.0676303142, at: "2026-09-16T23:39:30.524Z", grade: "consensus", signature: "wiD005d9...", kid: "pvi-Sl40p5Gj2t_-JyKUhxyg" }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'From the print, unchanged.' },
        price: { type: 'number', description: 'From the print. Used only if priceText is absent.' },
        priceText: { type: 'string', description: 'The price EXACTLY as Pulse served it. This is what was signed — prefer it always.' },
        at: { type: 'string', description: 'From the print, unchanged. A 1ms difference invalidates the signature.' },
        grade: { type: 'string', description: 'From the print: consensus, blended or indicative.' },
        signature: { type: 'string', description: 'Base64 signature from the print.' },
        kid: { type: 'string', description: 'Key id from the print; selects which public key to check against.' },
        sig: { type: 'string', description: 'Scheme tag from the print (pulse-index-v1).' },
      },
      required: ['symbol', 'at', 'grade', 'signature'],
    },
  },
  {
    name: 'pulse_asset_catalog',
    description:
      'Which crypto assets the Pulse Verity Index covers, at what grade, across how many venues, and how fast each one actually updates — cadence measured per asset from its own update intervals rather than from a poll schedule. Filter by coverage band (real-time, five-second, ten-second, slow, unavailable) or status (consensus, blended, indicative). Call this to find out whether a symbol is covered, and how thin it is, before quoting it. NOTE: these rows are UNSIGNED, including their prices — read a verifiable number through pulse_signed_price. Requires a Pulse API key via _apiKey. Example: pulse_asset_catalog({ limit: 5 }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Rows to return, max 500 (default 50).' },
        offset: { type: 'number', description: 'Row offset for paging.' },
        band: { type: 'string', description: 'Cadence band: real-time, five-second, ten-second, slow, unavailable.' },
        status: { type: 'string', description: 'Coverage grade: consensus, blended, indicative.' },
        _apiKey: KEY_ARG,
      },
      required: [],
    },
  },
  {
    name: 'pulse_key_ring',
    description:
      "The public keys Pulse signs its price prints with, as PEM and JWK, plus the signing algorithm and the exact canonical string format — everything needed to verify a signed print yourself, OFFLINE, with no network call to Pulse. Use it to write your own verifier, or to audit what pulse_verify_print (this pack's ready-made offline checker) is checking against. Needs NO API key. Example: pulse_key_ring({}).",
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  },
];

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const apiKey = (args._apiKey as string | undefined) || undefined;
  delete args._apiKey;
  switch (name) {
    case 'pulse_signed_price': return signedPrice(args, apiKey);
    case 'pulse_signed_batch': return signedBatch(args, apiKey);
    case 'pulse_settlement_print': return settlementPrint(args, apiKey);
    case 'pulse_verify_print': return verifyPrint(args);
    case 'pulse_asset_catalog': return assetCatalog(args, apiKey);
    case 'pulse_key_ring': return keyRing(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool, ringMeta };
export default { tools, callTool } satisfies McpToolExport;

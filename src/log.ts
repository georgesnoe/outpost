import { appendFileSync } from "node:fs"

/**
 * Audit log destination. Set OUTPOST_LOG to another path, or to "off" to keep
 * the log on stdout only.
 */
const LOG_FILE = process.env.OUTPOST_LOG ?? "outpost.log"

export type AuditEvent = {
  event: string
  actor: string
  ip: string | null
  [key: string]: unknown
}

export type AuditEntry = AuditEvent & { ts: string }

function format(entry: AuditEntry): string {
  const { ts, event, actor, ip, ...rest } = entry
  const parts = [`[${ts}]`, event, `actor=${actor}`]
  if (ip) parts.push(`ip=${ip}`)
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || value === null) continue
    parts.push(`${key}=${value}`)
  }
  return parts.join(" ")
}

/** Records one audited action: JSON line in the log file, readable line on stdout. */
export function audit(event: AuditEvent) {
  const entry: AuditEntry = { ts: new Date().toISOString(), ...event }

  if (LOG_FILE !== "off") {
    try {
      appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`)
    } catch (error) {
      console.error(
        `outpost: cannot write ${LOG_FILE}: ${(error as Error).message}`
      )
    }
  }

  console.log(format(entry))
}

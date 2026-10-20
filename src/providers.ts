import { BlockList } from "node:net"

/**
 * IP ranges of the AI providers we can attribute traffic to.
 *
 * Anthropic publishes its own ranges, so those are authoritative:
 * https://platform.claude.com/docs/en/api/ip-addresses
 *
 * xAI does not publish a list. The Grok entries are the edge addresses that
 * api.x.ai and grok.com currently resolve to - they sit behind a shared CDN
 * edge, so the match is best effort by nature.
 */
const PROVIDER_RANGES: { name: string; ranges: string[] }[] = [
  {
    name: "Claude (Anthropic)",
    ranges: [
      "160.79.104.0/23", // inbound
      "160.79.104.0/21", // outbound (tool calls to external servers)
      "2607:6bc0::/48" // inbound, IPv6
    ]
  },
  {
    name: "Grok (xAI)",
    ranges: [
      "8.6.112.0/32",
      "8.6.112.5/32",
      "8.47.69.0/32",
      "8.47.69.5/32",
      "13.57.44.126/32",
      "34.48.4.24/32",
      "35.227.192.44/32",
      "54.176.155.172/32",
      "104.18.18.80/32",
      "104.18.19.80/32",
      "104.18.26.175/32",
      "104.18.27.175/32",
      "104.18.28.234/32",
      "104.18.29.234/32",
      "199.16.156.218/32",
      "199.16.156.221/32",
      "2a06:98c1:3122:8000::/128",
      "2a06:98c1:3122:8000::5/128",
      "2a06:98c1:3123:8000::/128",
      "2a06:98c1:3123:8000::5/128",
      "2606:4700::6812:1aaf/128",
      "2606:4700::6812:1baf/128",
      "2606:4700::6812:1cea/128",
      "2606:4700::6812:1dea/128",
      "2606:4700::6812:1250/128",
      "2606:4700::6812:1350/128"
    ]
  }
]

const providers = PROVIDER_RANGES.map(({ name, ranges }) => {
  const list = new BlockList()
  for (const range of ranges) {
    const [address, prefix] = range.split("/")
    if (!address || !prefix) continue
    list.addSubnet(
      address,
      Number(prefix),
      address.includes(":") ? "ipv6" : "ipv4"
    )
  }
  return { name, list }
})

export type Identity = {
  /** Provider name when known, otherwise the raw IP address. */
  actor: string
  ip: string | null
}

function normalize(raw: string | null | undefined): string | null {
  if (!raw) return null
  let value = raw.split(",")[0]?.trim()
  if (!value) return null

  if (value.startsWith("[")) {
    // [::1]:8080
    const end = value.indexOf("]")
    if (end > 0) value = value.slice(1, end)
  } else if (
    value.indexOf(":") === value.lastIndexOf(":") &&
    value.indexOf(":") > 0
  ) {
    // 1.2.3.4:8080
    const host = value.slice(0, value.indexOf(":"))
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) value = host
  }

  // ::ffff:1.2.3.4 is an IPv4 address in IPv6 clothing
  if (value.startsWith("::ffff:") && value.includes(".")) return value.slice(7)
  return value
}

/**
 * Resolves an IP address to the provider that owns it, falling back to the raw
 * address for everything we do not know.
 */
export function identify(rawIp: string | null | undefined): Identity {
  const ip = normalize(rawIp)
  if (!ip) return { actor: "unknown", ip: null }

  const families = ip.includes(":")
    ? (["ipv6", "ipv4"] as const)
    : (["ipv4", "ipv6"] as const)
  for (const provider of providers) {
    for (const family of families) {
      try {
        if (provider.list.check(ip, family)) return { actor: provider.name, ip }
      } catch {
        // not a valid address for that family
      }
    }
  }
  return { actor: ip, ip }
}

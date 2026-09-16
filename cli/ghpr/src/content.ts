// GitHub review bots mix Markdown with HTML badges and hidden metadata.
export function cleanMarkdown(body: string) {
  return body.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g).map((part, index) => index % 2 ? part : part.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\[vc\]:.*$/gm, "")
    .replace(/<a\b[^>]*>\s*<picture\b[^>]*>[\s\S]*?<\/picture>\s*<\/a>/gi, "")
    .replace(/<img\b[^>]*>/gi, tag => {
      const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] || ""
      const src = tag.match(/\bsrc=["']([^"']*)["']/i)?.[1]
      if (/^P[0-4]$/i.test(alt)) return alt
      return src ? `[${alt || "Image"}](${src})` : alt
    })
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n${"#".repeat(Number(level))} `)
    .replace(/<br\s*\/?>|<\/(?:h[1-6]|p|div|summary|details)>|<(?:p|div|summary|details)\b[^>]*>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")).join("").trim()
}

export function commentPreview(body: string) {
  const text = cleanMarkdown(body).replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*`_]/g, "").replace(/\s+/g, " ").trim()
  return text.length > 180 ? `${text.slice(0, 177)}…` : text
}

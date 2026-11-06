// A GitHub comment as a document of its own, for a sandboxed frame in the
// PRs tab: GitHub's rendered HTML, under a policy that runs no script and
// loads nothing but https images and its own style, with links opening
// outside the frame, in the dashboard's colors. The comments are other
// people's, and the dashboard's origin can open files and message agents,
// so their HTML never goes into the page itself. No Node imports: the page
// builds it.

export interface CommentLook {
  background: string
  text: string
  muted: string
  border: string
  link: string
  font: string
  size: string
}

const CSP = "default-src 'none'; img-src https:; style-src 'unsafe-inline'"

/** A value safe inside a <style> declaration */
const css = (v: string) => v.replace(/[<>{};\\]/g, "")

export function commentDoc(html: string, look: CommentLook): string {
  const l: CommentLook = {
    background: css(look.background),
    text: css(look.text),
    muted: css(look.muted),
    border: css(look.border),
    link: css(look.link),
    font: css(look.font),
    size: css(look.size),
  }
  return `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<base target="_blank">
<style>
html { color-scheme: light dark; }
body { margin: 0; background: ${l.background}; color: ${l.text}; font: ${l.size}/1.45 ${l.font}; overflow-wrap: anywhere; }
a { color: ${l.link}; }
p, ul, ol, pre, blockquote, details, table { margin: 0 0 6px; }
pre, code { font-family: inherit; }
pre { padding: 6px 8px; border: 1px solid ${l.border}; border-radius: 4px; white-space: pre-wrap; }
blockquote { padding-left: 8px; border-left: 2px solid ${l.border}; color: ${l.muted}; }
img { max-width: 100%; }
table { border-collapse: collapse; }
td, th { border: 1px solid ${l.border}; padding: 2px 6px; }
</style>
</head><body>${html}</body></html>`
}

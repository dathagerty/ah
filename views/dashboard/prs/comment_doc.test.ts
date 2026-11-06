import { expect, test } from "vitest"
import { commentDoc } from "./comment_doc.ts"

const look = {
  background: "#fbf7f0",
  text: "#000000",
  muted: "#595959",
  border: "#c2bcb5",
  link: "#3548cf",
  font: '"Atkinson Hyperlegible Mono", monospace',
  size: "15px",
}

test("a comment's HTML goes in a document that can't run script or load more than images", () => {
  const doc = commentDoc("<p>Looks <em>good</em></p>", look)
  expect(doc).toContain("<p>Looks <em>good</em></p>")
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(doc)?.[1]
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("img-src https:")
  expect(csp).toContain("style-src 'unsafe-inline'")
  expect(csp).not.toMatch(/script-src(?! 'none')/)
})

test("its links open outside the frame", () => {
  expect(commentDoc("<a href='https://x'>x</a>", look)).toContain('<base target="_blank">')
})

test("it's styled in the dashboard's colors and font", () => {
  const doc = commentDoc("", look)
  for (const value of Object.values(look)) expect(doc).toContain(value)
})

test("a look value can't break out of the style element", () => {
  const doc = commentDoc("", { ...look, font: "x;}</style><script>alert(1)</script>" })
  expect(doc).not.toContain("<script>")
  expect(doc.match(/<\/style>/g)).toHaveLength(1)
})

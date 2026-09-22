/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'

/**
 * Markdown → React elements for newsletter campaign bodies.
 *
 * Deliberately NOT markdown → HTML string. A campaign body is typed by a
 * person into the Hub, and the one thing that must never happen is that text
 * reaching a customer's inbox as live markup. React escapes every text node it
 * renders, so producing ELEMENTS (never a string handed to
 * dangerouslySetInnerHTML) makes raw HTML in the body impossible by
 * construction rather than by a sanitiser anyone could later loosen.
 *
 * Supported, and nothing else: paragraphs, blank-line separation, # / ## / ###
 * headings, - and 1. lists, [text](url) links, **bold**, *italic*.
 * Anything else is rendered as plain text.
 */

const ALLOWED_LINK = /^(https?:\/\/|mailto:)/i

type Inline = React.ReactNode

/** Inline pass: links first (they may contain bold), then bold, then italic. */
function inline(text: string, keyPrefix: string): Inline[] {
  const out: Inline[] = []
  const linkRe = /\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = linkRe.exec(text)) !== null) {
    if (m.index > last) out.push(...emphasis(text.slice(last, m.index), `${keyPrefix}t${i}`))
    const href = m[2]
    if (ALLOWED_LINK.test(href)) {
      out.push(
        <a key={`${keyPrefix}a${i}`} href={href} style={link}>
          {emphasis(m[1], `${keyPrefix}al${i}`)}
        </a>,
      )
    } else {
      // Not an http(s)/mailto target: render the label as text, drop the href.
      out.push(...emphasis(m[1], `${keyPrefix}ap${i}`))
    }
    last = m.index + m[0].length
    i++
  }
  if (last < text.length) out.push(...emphasis(text.slice(last), `${keyPrefix}t${i}`))
  return out
}

function emphasis(text: string, keyPrefix: string): Inline[] {
  const out: Inline[] = []
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[2] !== undefined) {
      out.push(<strong key={`${keyPrefix}b${i}`}>{m[2]}</strong>)
    } else {
      out.push(<em key={`${keyPrefix}i${i}`}>{m[4]}</em>)
    }
    last = m.index + m[0].length
    i++
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function renderMarkdown(body: string): React.ReactNode[] {
  const lines = (body ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let k = 0

  const flushPara = () => {
    if (para.length === 0) return
    blocks.push(
      <p key={`p${k++}`} style={paragraph}>
        {inline(para.join(' '), `p${k}`)}
      </p>,
    )
    para = []
  }
  const flushList = () => {
    if (!list) return
    const items = list.items.map((it, n) => (
      <li key={`li${n}`} style={listItem}>
        {inline(it, `l${k}i${n}`)}
      </li>
    ))
    blocks.push(
      list.ordered
        ? <ol key={`ol${k++}`} style={listStyle}>{items}</ol>
        : <ul key={`ul${k++}`} style={listStyle}>{items}</ul>,
    )
    list = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      flushPara()
      flushList()
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      flushPara()
      flushList()
      const level = heading[1].length
      const style = level === 1 ? h1 : level === 2 ? h2 : h3
      blocks.push(
        <p key={`h${k++}`} style={style}>
          {inline(heading[2], `h${k}`)}
        </p>,
      )
      continue
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (bullet || numbered) {
      flushPara()
      const ordered = !!numbered
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push((bullet ?? numbered)![1])
      continue
    }
    flushList()
    para.push(line.trim())
  }
  flushPara()
  flushList()
  return blocks
}

const paragraph = { fontSize: '15px', color: '#42454b', lineHeight: '1.7', padding: '0 24px', margin: '0 0 14px' }
const h1 = { fontSize: '20px', fontWeight: 'bold' as const, color: '#1a1a2e', padding: '0 24px', margin: '20px 0 10px' }
const h2 = { fontSize: '17px', fontWeight: 'bold' as const, color: '#1a1a2e', padding: '0 24px', margin: '18px 0 8px' }
const h3 = { fontSize: '15px', fontWeight: 'bold' as const, color: '#1a1a2e', padding: '0 24px', margin: '16px 0 6px' }
const listStyle = { fontSize: '15px', color: '#42454b', lineHeight: '1.7', padding: '0 24px 0 44px', margin: '0 0 14px' }
const listItem = { margin: '0 0 6px' }
const link = { color: '#a37e1f', textDecoration: 'underline' }

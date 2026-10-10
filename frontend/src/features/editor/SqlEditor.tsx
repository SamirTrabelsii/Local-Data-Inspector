import { closeCompletion } from '@codemirror/autocomplete'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { PostgreSQL, sql, SQLDialect, StandardSQL } from '@codemirror/lang-sql'
import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import CodeMirror from '@uiw/react-codemirror'
import { useMemo, useRef, useState } from 'react'

const BigQuerySQL = SQLDialect.define({ ...StandardSQL.spec, identifierQuotes: '`' })

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: '#e8eaf0', height: '100%', fontSize: '13px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
    '.cm-content': { caretColor: '#8b7cff', padding: '12px 0' },
    '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: '#454b5c', paddingLeft: '6px' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.025)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8f97aa' },
    '.cm-cursor': { borderLeftColor: '#8b7cff', borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'rgba(139,124,255,0.26) !important',
    },
    '.cm-matchingBracket': { backgroundColor: 'rgba(139,124,255,0.22)', outline: 'none' },
    '.cm-tooltip': {
      backgroundColor: '#151821',
      border: '1px solid #2c3140',
      borderRadius: '10px',
      overflow: 'hidden',
      boxShadow: '0 16px 40px -12px rgba(0,0,0,0.8)',
    },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12px', padding: '4px' },
    '.cm-tooltip-autocomplete > ul > li': { borderRadius: '6px', padding: '2px 8px !important' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'rgba(139,124,255,0.28)', color: '#fff' },
    '.cm-completionDetail': { color: '#5d6477', fontStyle: 'normal', marginLeft: '8px' },
  },
  { dark: true },
)

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: '#c4b5fd', fontWeight: '500' },
  { tag: [t.string, t.special(t.string)], color: '#86efac' },
  { tag: [t.number, t.bool, t.null], color: '#fdba74' },
  { tag: [t.lineComment, t.blockComment], color: '#5d6477', fontStyle: 'italic' },
  { tag: [t.typeName, t.standard(t.name)], color: '#7dd3fc' },
  { tag: t.special(t.name), color: '#67e8f9' },
  { tag: [t.operator, t.punctuation, t.bracket], color: '#8f97aa' },
])

interface Props {
  value: string
  onChange: (v: string) => void
  onRun: () => void
  dialect: 'bigquery' | 'duckdb'
  /** Upstream table name -> column names, for autocomplete. */
  schema?: Record<string, string[]>
}

export function SqlEditor({ value, onChange, onRun, dialect, schema }: Props) {
  const onRunRef = useRef(onRun)
  onRunRef.current = onRun
  // Uncontrolled: the editor owns the text after mount (remount with a key to load other SQL).
  // Feeding `value` back in races with fast typing and can restore stale text.
  const [initial] = useState(value)

  const extensions = useMemo(
    () => [
      sql({ dialect: dialect === 'bigquery' ? BigQuerySQL : PostgreSQL, schema, upperCaseKeywords: true }),
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              closeCompletion(view)
              onRunRef.current()
              return true
            },
          },
        ]),
      ),
    ],
    [dialect, schema],
  )

  return (
    <CodeMirror
      value={initial}
      onChange={onChange}
      extensions={extensions}
      theme={theme}
      height="100%"
      className="h-full"
      basicSetup={{ foldGutter: false, highlightActiveLineGutter: true, searchKeymap: true }}
      autoFocus
    />
  )
}

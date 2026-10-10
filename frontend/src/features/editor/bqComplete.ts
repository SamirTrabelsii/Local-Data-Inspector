import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { BqField } from '../../lib/api'
import { catalogQueries, fetchCatalog } from '../../lib/catalog'

/**
 * BigQuery autocomplete from live metadata:
 * - `project.dataset.table` paths (bare or inside backticks), level by level
 * - columns of the tables the query reads, bare or after their alias (`o.`)
 */

const NOT_ALIAS = new Set(
  'WHERE JOIN LEFT RIGHT INNER OUTER FULL CROSS ON USING GROUP ORDER LIMIT UNION EXCEPT INTERSECT QUALIFY WINDOW HAVING FOR TABLESAMPLE UNNEST'.split(
    ' ',
  ),
)
const TABLE_REF = /\b(?:FROM|JOIN)\s+(?:`([^`]+)`|([\w-]+\.[\w-]+(?:\.[\w-]+)?))(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi

interface TableRef {
  id: string
  alias?: string
}

function tableRefs(doc: string): TableRef[] {
  const refs: TableRef[] = []
  for (const m of doc.matchAll(TABLE_REF)) {
    const id = m[1] ?? m[2]
    if (id.split('.').length < 2) continue
    const alias = m[3] && !NOT_ALIAS.has(m[3].toUpperCase()) ? m[3] : undefined
    refs.push({ id, alias })
  }
  return refs
}

async function billingProject(): Promise<string | undefined> {
  return (await fetchCatalog(catalogQueries.projects()))?.billing ?? undefined
}

/** `dataset.table` uses the billing project, like BigQuery does. */
async function fullId(id: string): Promise<string | undefined> {
  const parts = id.split('.')
  if (parts.length === 3) return id
  const billing = await billingProject()
  return billing ? `${billing}.${id}` : undefined
}

const flatten = (fields: BqField[], prefix = ''): BqField[] =>
  fields.flatMap((f) => [
    { ...f, name: prefix + f.name },
    ...(f.fields ? flatten(f.fields, `${prefix}${f.name}.`) : []),
  ])

async function columnsOf(id: string): Promise<BqField[]> {
  const full = await fullId(id)
  if (!full) return []
  const info = await fetchCatalog(catalogQueries.table(full))
  return info ? flatten(info.columns) : []
}

const columnOptions = (cols: BqField[], table: string, boost = 0): Completion[] =>
  cols.map((c) => ({ label: c.name, type: 'property', detail: `${c.type} · ${table.split('.').pop()}`, boost }))

export async function bqCompletions(ctx: CompletionContext): Promise<CompletionResult | null> {
  const line = ctx.state.doc.lineAt(ctx.pos)
  const before = line.text.slice(0, ctx.pos - line.from)
  const token = /[\w.-]*$/.exec(before)![0]
  const inBackticks = (before.match(/`/g)?.length ?? 0) % 2 === 1
  const parts = token.split('.')
  const last = parts.pop()!
  const from = ctx.pos - last.length
  const afterTableKeyword = /\b(FROM|JOIN)\s+`?[\w.-]*$/i.test(before)
  if (!ctx.explicit && !last && !parts.length) return null

  const done = (options: Completion[]): CompletionResult | null =>
    options.length ? { from, options, validFor: /^[\w-]*$/ } : null

  // project / dataset / table paths
  if (parts.length === 0 && (inBackticks || afterTableKeyword)) {
    const proj = await fetchCatalog(catalogQueries.projects())
    if (!proj) return null
    const datasets = proj.billing ? ((await fetchCatalog(catalogQueries.datasets(proj.billing))) ?? []) : []
    return done([
      ...proj.projects.map((p) => ({ label: p, type: 'namespace', detail: 'project', boost: 2 })),
      ...datasets.map((d) => ({ label: d.id, type: 'class', detail: 'dataset' })),
    ])
  }
  if (parts.length === 1 || (parts.length === 2 && (inBackticks || afterTableKeyword))) {
    const proj = await fetchCatalog(catalogQueries.projects())
    if (parts.length === 2) {
      const tables = await fetchCatalog(catalogQueries.tables(parts[0], parts[1]))
      return done((tables ?? []).map((t) => ({ label: t.id, type: 'type', detail: t.type.toLowerCase() })))
    }
    const [head] = parts
    // alias or table name -> its columns
    const ref = tableRefs(ctx.state.doc.toString()).find((r) => r.alias === head || r.id.split('.').pop() === head)
    if (ref && !inBackticks) return done(columnOptions(await columnsOf(ref.id), ref.id))
    if (proj?.projects.includes(head) || inBackticks || afterTableKeyword) {
      const datasets = await fetchCatalog(catalogQueries.datasets(head))
      if (datasets?.length) return done(datasets.map((d) => ({ label: d.id, type: 'class', detail: 'dataset' })))
      if (proj?.billing) {
        const tables = await fetchCatalog(catalogQueries.tables(proj.billing, head))
        return done((tables ?? []).map((t) => ({ label: t.id, type: 'type', detail: t.type.toLowerCase() })))
      }
    }
    return null
  }
  if (parts.length > 0 || inBackticks) return null

  // bare word: columns of every table the query reads
  const refs = tableRefs(ctx.state.doc.toString())
  const lists = await Promise.all(refs.map(async (r) => columnOptions(await columnsOf(r.id), r.id, 1)))
  const seen = new Set<string>()
  return done(lists.flat().filter((o) => !seen.has(o.label) && seen.add(o.label)))
}

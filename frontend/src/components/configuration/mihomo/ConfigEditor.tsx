import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  IconChevronDown,
  IconChevronUp,
  IconDeviceFloppy,
  IconGripVertical,
  IconPlus,
  IconPlugX,
  IconReload,
  IconRoute,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import * as jsyaml from 'js-yaml'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiCall } from '../../../lib/api'
import { useAppContext } from '../../../lib/store'

/* ============================================================
   Структурный редактор config.yaml для mihomo.
   Читает конфиг через GET /api/configs?core=mihomo, правит
   структуру через js-yaml, сохраняет через PUT /api/configs.
   Никаких изменений в Rust-бэкенде не требуется.
   ============================================================ */

const GROUP_TYPES = ['select', 'url-test', 'fallback', 'load-balance', 'relay'] as const
const DEFAULT_HC_URL = 'http://www.gstatic.com/generate_204'

type GroupType = (typeof GROUP_TYPES)[number]

interface ProxyGroup {
  name?: string
  type?: GroupType
  'include-all'?: boolean
  proxies?: string[]
  url?: string
  interval?: number
  tolerance?: number
  [k: string]: unknown
}

interface MihomoDoc {
  'proxy-groups'?: ProxyGroup[]
  'proxy-providers'?: Record<string, Record<string, unknown>>
  'rule-providers'?: Record<string, Record<string, unknown>>
  rules?: string[]
  [k: string]: unknown
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: () => void | Promise<unknown>
  onApply?: () => void | Promise<unknown>
}

const NO_ROUTE = '__none__'

/* Найти индекс простого правила RULE-SET для данного списка.
   Формат: "RULE-SET,<provider>,<target>[,no-resolve]".
   Сложные правила (AND/OR/...) не трогаем. */
function findRuleSetIndex(rules: string[], provider: string): number {
  return rules.findIndex((r) => {
    const parts = String(r).split(',')
    return parts[0]?.trim() === 'RULE-SET' && parts[1]?.trim() === provider
  })
}

/* Текущий селектор (target) для списка, либо null если правила нет. */
function getRouteTarget(rules: string[], provider: string): string | null {
  const i = findRuleSetIndex(rules, provider)
  if (i < 0) return null
  const parts = String(rules[i]).split(',')
  // target = всё после второй запятой, без хвоста no-resolve
  const rest = parts.slice(2).join(',').trim()
  return rest.replace(/,no-resolve$/i, '').trim() || null
}

/* Установить/обновить/удалить правило RULE-SET для списка.
   target === NO_ROUTE → удалить правило. Иначе вставить/обновить.
   Вставка — перед последним MATCH (или в конец, если MATCH нет). */
function setRoute(doc: MihomoDoc, provider: string, target: string) {
  const rules = doc.rules ?? (doc.rules = [])
  const idx = findRuleSetIndex(rules, provider)
  if (target === NO_ROUTE) {
    if (idx >= 0) rules.splice(idx, 1)
    return
  }
  const line = `RULE-SET,${provider},${target}`
  if (idx >= 0) {
    rules[idx] = line
  } else {
    const matchIdx = rules.findIndex((r) => String(r).split(',')[0]?.trim() === 'MATCH')
    if (matchIdx >= 0) rules.splice(matchIdx, 0, line)
    else rules.push(line)
  }
}

/* Переименовать список во всех ссылающихся правилах RULE-SET. */
function renameRoute(doc: MihomoDoc, oldName: string, newName: string) {
  const rules = doc.rules ?? []
  for (let i = 0; i < rules.length; i++) {
    const parts = String(rules[i]).split(',')
    if (parts[0]?.trim() === 'RULE-SET' && parts[1]?.trim() === oldName) {
      parts[1] = newName
      rules[i] = parts.join(',')
    }
  }
}

/* Переименование СЕЛЕКТОРА (proxy-group) — распространить на все ссылки,
   чтобы конфиг не падал с "proxy [X] not found":
   1) target-поле в правилах (последний сегмент, либо предпоследний при no-resolve);
   2) members других групп (proxies). */
function renameGroupEverywhere(doc: MihomoDoc, oldName: string, newName: string) {
  // правила
  const rules = doc.rules ?? []
  for (let i = 0; i < rules.length; i++) {
    const parts = String(rules[i]).split(',')
    // target обычно последний сегмент; учесть хвост no-resolve/src-* у IP-правил
    let ti = parts.length - 1
    if (/^(no-resolve|src)$/i.test(parts[ti]?.trim() ?? '')) ti -= 1
    if (parts[ti]?.trim() === oldName) {
      parts[ti] = newName
      rules[i] = parts.join(',')
    }
  }
  // members других групп
  for (const g of doc['proxy-groups'] ?? []) {
    if (!Array.isArray(g.proxies)) continue
    g.proxies = g.proxies.map((p) => (p === oldName ? newName : p))
  }
}

function dumpYaml(doc: MihomoDoc): string {
  const clone = JSON.parse(JSON.stringify(doc)) as MihomoDoc
  for (const g of clone['proxy-groups'] ?? []) {
    if (Array.isArray(g.proxies) && g.proxies.length === 0) delete g.proxies
  }
  return jsyaml.dump(clone, { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false, sortKeys: false })
}

export function ConfigEditorModal({ open, onOpenChange, onSaved, onApply }: Props) {
  const { showToast } = useAppContext()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState(false)
  const [tab, setTab] = useState('groups')
  const [doc, setDoc] = useState<MihomoDoc | null>(null)
  const fileRef = useRef<string>('')
  // bump форсирует ререндер после мутаций по ссылке
  const [, bump] = useState(0)
  const rerender = useCallback(() => bump((n) => n + 1), [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await apiCall<{ success: boolean; configs?: { file: string; content: string }[] }>('GET', 'configs?core=mihomo')
      const yamls = (res.configs ?? []).filter((c) => c.file.endsWith('.yaml') || c.file.endsWith('.yml'))
      // основной конфиг mihomo: тот, где есть proxy-groups/rules, а не proxy_providers/*.yaml
      const main =
        yamls.find((c) => /proxy-groups\s*:/.test(c.content) || /^rules\s*:/m.test(c.content)) ??
        yamls.find((c) => !/proxy_providers\//.test(c.file)) ??
        yamls[0]
      if (!main) throw new Error('no config')
      const parsed = (jsyaml.load(main.content) ?? {}) as MihomoDoc
      parsed['proxy-groups'] ??= []
      parsed['proxy-providers'] ??= {}
      parsed['rule-providers'] ??= {}
      fileRef.current = main.file
      setDoc(parsed)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  // Возвращает true при успешной записи на диск.
  async function writeConfig(): Promise<boolean> {
    if (!doc) return false
    const content = dumpYaml(doc)
    const res = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs', { file: fileRef.current, content })
    if (!res.success) {
      showToast('Ошибка сохранения: ' + (res.error || ''), 'error')
      return false
    }
    // Перезагрузить редактор/состояние панели, иначе её текстовый редактор
    // хранит старое содержимое и при сохранении перезапишет наши правки.
    await onSaved?.()
    return true
  }

  async function save() {
    setSaving(true)
    try {
      if (await writeConfig()) {
        showToast('config.yaml сохранён', 'success')
      }
    } finally {
      setSaving(false)
    }
  }

  async function saveAndApply() {
    setApplying(true)
    try {
      if (await writeConfig()) {
        await onApply?.() // мягкий перезапуск ядра (тосты показывает панель)
      }
    } finally {
      setApplying(false)
    }
  }

  const groups = doc?.['proxy-groups'] ?? []
  const providers = doc?.['proxy-providers'] ?? {}
  const ruleProviders = doc?.['rule-providers'] ?? {}
  const inlineRuleNames = Object.keys(ruleProviders).filter(
    (k) => (ruleProviders[k] as { type?: string })?.type === 'inline'
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] max-h-[90vh] w-[min(1000px,96vw)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="flex flex-col gap-3 border-b border-border px-5 py-4">
          <DialogTitle className="pr-8 text-base">Редактор config.yaml</DialogTitle>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="flex-wrap">
                <TabsTrigger value="groups">Селекторы</TabsTrigger>
                <TabsTrigger value="subs">Подписки</TabsTrigger>
                <TabsTrigger value="rules">Сайты и IP</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={save}
                disabled={saving || applying || loading || error || !doc}
              >
                {saving ? <Spinner className="size-4" /> : <IconDeviceFloppy size={15} />} Сохранить
              </Button>
              <Button size="sm" onClick={saveAndApply} disabled={saving || applying || loading || error || !doc || !onApply}>
                {applying ? <Spinner className="size-4" /> : <IconReload size={15} />} Сохранить и применить
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="text-muted-foreground flex items-center justify-center py-20 text-sm">
              <Spinner className="mr-2 size-5" /> Загрузка...
            </div>
          ) : error || !doc ? (
            <Empty className="text-muted-foreground gap-3 py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <IconPlugX />
                </EmptyMedia>
                <EmptyTitle className="text-sm">Не удалось загрузить config.yaml</EmptyTitle>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" size="sm" onClick={load}>
                  Повторить
                </Button>
              </EmptyContent>
            </Empty>
          ) : tab === 'groups' ? (
            <GroupsTab doc={doc} groups={groups} providers={providers} rerender={rerender} showToast={showToast} />
          ) : tab === 'subs' ? (
            <SubsTab doc={doc} rerender={rerender} showToast={showToast} />
          ) : (
            <RulesTab doc={doc} inlineNames={inlineRuleNames} rerender={rerender} showToast={showToast} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ====================== СЕЛЕКТОРЫ ====================== */
function GroupsTab({
  doc,
  groups,
  providers,
  rerender,
  showToast,
}: {
  doc: MihomoDoc
  groups: ProxyGroup[]
  providers: Record<string, unknown>
  rerender: () => void
  showToast: (m: string, t?: 'success' | 'error') => void
}) {
  function addGroup() {
    let i = 1
    while (groups.some((g) => g.name === `Новый ${i}`)) i++
    groups.push({ name: `Новый ${i}`, type: 'select', proxies: ['DIRECT'] })
    rerender()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={addGroup}>
          <IconPlus size={15} /> Селектор
        </Button>
      </div>
      {groups.length === 0 && <p className="text-muted-foreground py-8 text-center text-sm">Нет селекторов</p>}
      {groups.map((g, gi) => (
        <GroupCard
          key={gi}
          group={g}
          index={gi}
          total={groups.length}
          targets={['DIRECT', 'REJECT', ...groups.filter((x) => x.name && x !== g).map((x) => x.name!)]}
          providers={Object.keys(providers)}
          onRename={(nv) => {
            const old = g.name ?? ''
            if (!nv || nv === old) return
            if (groups.some((x) => x !== g && x.name === nv)) {
              showToast('Имя группы занято', 'error')
              return
            }
            g.name = nv
            // обновить все ссылки на старое имя (правила + members других групп),
            // иначе mihomo упадёт с "proxy [...] not found"
            renameGroupEverywhere(doc, old, nv)
            rerender()
          }}
          onMove={(dir) => {
            const j = gi + dir
            if (j < 0 || j >= groups.length) return
            ;[groups[gi], groups[j]] = [groups[j], groups[gi]]
            rerender()
          }}
          onDelete={() => {
            groups.splice(gi, 1)
            rerender()
          }}
          rerender={rerender}
        />
      ))}
    </div>
  )
}

function GroupCard({
  group,
  index,
  total,
  targets,
  providers,
  onRename,
  onMove,
  onDelete,
  rerender,
}: {
  group: ProxyGroup
  index: number
  total: number
  targets: string[]
  providers: string[]
  onRename: (nv: string) => void
  onMove: (dir: number) => void
  onDelete: () => void
  rerender: () => void
}) {
  const [addVal, setAddVal] = useState('')
  const members = group.proxies ?? (group.proxies = [])
  const isAuto = group.type === 'url-test' || group.type === 'fallback' || group.type === 'load-balance'
  const dragFrom = useRef<number | null>(null)

  function add(val: string) {
    const v = val.trim()
    if (!v || members.includes(v)) return
    members.push(v)
    setAddVal('')
    rerender()
  }

  return (
    <div className="border-border bg-input-background rounded-xl border">
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="bg-accent/40 text-muted-foreground rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase">
            {group.type ?? 'select'}
          </span>
          <Input
            key={group.name}
            className="h-8 w-44 font-medium"
            defaultValue={group.name ?? ''}
            placeholder="Имя группы"
            onBlur={(e) => onRename(e.target.value.trim())}
          />
          <span className="text-muted-foreground hidden text-[11px] sm:inline">⏎ применить</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="icon-sm" disabled={index === 0} onClick={() => onMove(-1)}>
            <IconChevronUp size={14} />
          </Button>
          <Button variant="outline" size="icon-sm" disabled={index === total - 1} onClick={() => onMove(1)}>
            <IconChevronDown size={14} />
          </Button>
          <Button variant="outline" size="icon-sm" className="text-red-400" onClick={onDelete}>
            <IconTrash size={14} />
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-muted-foreground text-xs">Тип</label>
            <Select
              value={group.type ?? 'select'}
              onValueChange={(v) => {
                const t = v as GroupType
                group.type = t
                const auto = t === 'url-test' || t === 'fallback' || t === 'load-balance'
                if (auto) {
                  // url/interval обязательны для health-check, иначе url-test не работает.
                  // Записываем сразу, а не только при ручном вводе.
                  group.url ??= DEFAULT_HC_URL
                  group.interval ??= 300
                  if (t === 'url-test') group.tolerance ??= 50
                  else delete group.tolerance
                } else {
                  // у select/relay этих полей быть не должно
                  delete group.url
                  delete group.interval
                  delete group.tolerance
                }
                rerender()
              }}
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUP_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="mb-1.5 flex cursor-pointer items-center gap-2 text-sm">
            <Switch
              checked={!!group['include-all']}
              onCheckedChange={(v) => {
                if (v) group['include-all'] = true
                else delete group['include-all']
                rerender()
              }}
            />
            include-all
          </label>
        </div>

        {isAuto && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-52 flex-1 flex-col gap-1.5">
              <label className="text-muted-foreground text-xs">URL проверки</label>
              <Input
                className="h-8"
                value={group.url ?? DEFAULT_HC_URL}
                onChange={(e) => {
                  group.url = e.target.value
                  rerender()
                }}
              />
            </div>
            <div className="flex w-28 flex-col gap-1.5">
              <label className="text-muted-foreground text-xs">Интервал, с</label>
              <Input
                className="h-8"
                type="number"
                value={group.interval ?? 300}
                onChange={(e) => {
                  group.interval = +e.target.value || 300
                  rerender()
                }}
              />
            </div>
            {group.type === 'url-test' && (
              <div className="flex w-28 flex-col gap-1.5">
                <label className="text-muted-foreground text-xs">Tolerance, мс</label>
                <Input
                  className="h-8"
                  type="number"
                  value={group.tolerance ?? 50}
                  onChange={(e) => {
                    group.tolerance = +e.target.value || 0
                    rerender()
                  }}
                />
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-muted-foreground text-xs">Члены группы (перетащите для порядка)</label>
          {members.length === 0 && <p className="text-muted-foreground text-xs italic">Пусто</p>}
          {members.map((p, pi) => (
            <div
              key={pi}
              draggable
              onDragStart={() => (dragFrom.current = pi)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                const from = dragFrom.current
                if (from === null || from === pi) return
                const [m] = members.splice(from, 1)
                members.splice(pi, 0, m)
                dragFrom.current = null
                rerender()
              }}
              className="border-border bg-background flex items-center gap-2 rounded-lg border px-2.5 py-1.5"
            >
              <IconGripVertical size={15} className="text-muted-foreground cursor-grab" />
              <span className="flex-1 font-mono text-[13px]">{p}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  members.splice(pi, 1)
                  rerender()
                }}
              >
                <IconX size={14} />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <Select value="" onValueChange={(v) => add(v)}>
            <SelectTrigger size="sm" className="flex-1">
              <SelectValue placeholder="Добавить из списка" />
            </SelectTrigger>
            <SelectContent>
              {targets
                .filter((t) => !members.includes(t))
                .map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              {providers
                .filter((p) => !members.includes(p))
                .map((p) => (
                  <SelectItem key={p} value={p}>
                    {p} (подписка)
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Input
            className="h-8 flex-1"
            placeholder="или вручную"
            value={addVal}
            onChange={(e) => setAddVal(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add(addVal)}
          />
          <Button size="sm" variant="outline" onClick={() => add(addVal)}>
            <IconPlus size={15} />
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ====================== ПОДПИСКИ + FAILOVER ====================== */
function SubsTab({
  doc,
  rerender,
  showToast,
}: {
  doc: MihomoDoc
  rerender: () => void
  showToast: (m: string, t?: 'success' | 'error') => void
}) {
  const providers = doc['proxy-providers'] ?? (doc['proxy-providers'] = {})
  const names = Object.keys(providers)
  const [foMode, setFoMode] = useState<GroupType>('fallback')
  const [foName, setFoName] = useState('VPN')

  function addSub() {
    let i = names.length + 1
    while (providers[`sub${i}`]) i++
    const name = `sub${i}`
    providers[name] = {
      type: 'http',
      url: 'https://example.com/sub/your-link',
      path: `./proxy_providers/${name}.yaml`,
      interval: 3600,
      'health-check': { enable: true, url: DEFAULT_HC_URL, interval: 300 },
    }
    rerender()
  }

  function applyFailover() {
    const groups = doc['proxy-groups'] ?? (doc['proxy-groups'] = [])
    let g = groups.find((x) => x.name === foName)
    if (!g) {
      g = { name: foName }
      groups.unshift(g)
    }
    g.type = foMode
    g['include-all'] = true
    if (foMode === 'fallback' || foMode === 'url-test') {
      g.url ??= DEFAULT_HC_URL
      g.interval ??= 300
    }
    showToast(`Группа «${foName}» настроена: ${foMode}`, 'success')
    rerender()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={addSub}>
          <IconPlus size={15} /> Подписка
        </Button>
      </div>
      {names.length === 0 && <p className="text-muted-foreground py-8 text-center text-sm">Нет подписок</p>}

      {names.map((name) => {
        const s = providers[name] as Record<string, unknown>
        const hc = (s['health-check'] ?? (s['health-check'] = { enable: true, url: DEFAULT_HC_URL, interval: 300 })) as Record<
          string,
          unknown
        >
        return (
          <div key={name} className="border-border bg-input-background flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex items-center justify-between gap-2">
              <Input
                className="h-8 w-52 font-medium"
                defaultValue={name}
                onBlur={(e) => {
                  const nv = e.target.value.trim()
                  if (!nv || nv === name) return
                  if (providers[nv]) {
                    showToast('Имя занято', 'error')
                    e.target.value = name
                    return
                  }
                  providers[nv] = providers[name]
                  delete providers[name]
                  rerender()
                }}
              />
              <Button
                variant="outline"
                size="icon-sm"
                className="text-red-400"
                onClick={() => {
                  delete providers[name]
                  rerender()
                }}
              >
                <IconTrash size={14} />
              </Button>
            </div>
            <LabeledInput label="URL подписки" value={(s.url as string) ?? ''} onChange={(v) => ((s.url = v), rerender())} />
            <div className="grid grid-cols-2 gap-3">
              <LabeledInput
                label="Путь (path)"
                value={(s.path as string) ?? ''}
                onChange={(v) => ((s.path = v), rerender())}
              />
              <LabeledInput
                label="Интервал, с"
                type="number"
                value={String(s.interval ?? 3600)}
                onChange={(v) => ((s.interval = +v || 3600), rerender())}
              />
            </div>
            <div className="border-border grid grid-cols-2 gap-3 border-t pt-3">
              <LabeledInput
                label="Health-check URL"
                value={(hc.url as string) ?? DEFAULT_HC_URL}
                onChange={(v) => ((hc.url = v), rerender())}
              />
              <LabeledInput
                label="Health-check интервал, с"
                type="number"
                value={String(hc.interval ?? 300)}
                onChange={(v) => ((hc.interval = +v || 300), rerender())}
              />
            </div>
          </div>
        )
      })}

      <div className="border-border bg-input-background rounded-xl border p-4">
        <h4 className="mb-3 text-sm font-semibold">⚡ Failover между подписками</h4>
        {names.length < 2 ? (
          <p className="text-muted-foreground text-xs">
            Добавьте минимум 2 подписки для автопереключения. Сейчас: {names.length}.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
              Кнопка создаст/обновит группу с include-all (подтянет все прокси из всех подписок). fallback — упала, молча
              переключилось; url-test — выбор быстрейшей; select — вручную.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-56 flex-col gap-1.5">
                <label className="text-muted-foreground text-xs">Режим</label>
                <Select value={foMode} onValueChange={(v) => setFoMode(v as GroupType)}>
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fallback">fallback (авто, по порядку)</SelectItem>
                    <SelectItem value="url-test">url-test (авто, быстрейшая)</SelectItem>
                    <SelectItem value="select">select (вручную)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-40 flex-col gap-1.5">
                <label className="text-muted-foreground text-xs">Имя группы</label>
                <Input className="h-8" value={foName} onChange={(e) => setFoName(e.target.value)} />
              </div>
              <Button size="sm" className="mb-px" onClick={applyFailover}>
                Применить
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ====================== САЙТЫ И IP (inline rule-providers) ====================== */
function RulesTab({
  doc,
  inlineNames,
  rerender,
  showToast,
}: {
  doc: MihomoDoc
  inlineNames: string[]
  rerender: () => void
  showToast: (m: string, t?: 'success' | 'error') => void
}) {
  const ruleProviders = doc['rule-providers'] ?? (doc['rule-providers'] = {})
  const rules = doc.rules ?? (doc.rules = [])
  const selectorNames = (doc['proxy-groups'] ?? []).map((g) => g.name).filter((n): n is string => !!n)

  function addList() {
    let i = 1
    while (ruleProviders[`my-list${i > 1 ? i : ''}`]) i++
    const name = `my-list${i > 1 ? i : ''}`
    ruleProviders[name] = { type: 'inline', behavior: 'classical', format: 'text', payload: [] }
    rerender()
  }

  const httpCount = Object.keys(ruleProviders).filter((k) => (ruleProviders[k] as { type?: string })?.type === 'http').length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={addList}>
          <IconPlus size={15} /> Список
        </Button>
      </div>
      {inlineNames.length === 0 && (
        <p className="text-muted-foreground py-8 text-center text-sm">Нет встроенных списков (type: inline)</p>
      )}
      {inlineNames.map((name) => (
        <RuleCard
          key={name}
          name={name}
          rule={ruleProviders[name] as Record<string, unknown>}
          route={getRouteTarget(rules, name)}
          selectorNames={selectorNames}
          onSetRoute={(target) => {
            setRoute(doc, name, target)
            rerender()
          }}
          onRename={(nv) => {
            if (!nv || nv === name) return
            if (ruleProviders[nv]) {
              showToast('Имя занято', 'error')
              return
            }
            ruleProviders[nv] = ruleProviders[name]
            delete ruleProviders[name]
            renameRoute(doc, name, nv) // не дать правилу повиснуть на старом имени
            rerender()
          }}
          onDelete={() => {
            delete ruleProviders[name]
            setRoute(doc, name, NO_ROUTE) // заодно убрать ссылающееся правило
            rerender()
          }}
          rerender={rerender}
          showToast={showToast}
        />
      ))}
      {httpCount > 0 && (
        <p className="text-muted-foreground text-xs">
          Также есть {httpCount} внешних списков по URL — редактируются в текстовом редакторе config.yaml.
        </p>
      )}
    </div>
  )
}

function RuleCard({
  name,
  rule,
  route,
  selectorNames,
  onSetRoute,
  onRename,
  onDelete,
  rerender,
  showToast,
}: {
  name: string
  rule: Record<string, unknown>
  route: string | null
  selectorNames: string[]
  onSetRoute: (target: string) => void
  onRename: (nv: string) => void
  onDelete: () => void
  rerender: () => void
  showToast: (m: string, t?: 'success' | 'error') => void
}) {
  const behavior = (rule.behavior as string) ?? 'classical'
  const payload = (rule.payload ?? (rule.payload = [])) as string[]

  // Классифицируем на каждом рендере: payload мутируется по ссылке (push/splice),
  // поэтому useMemo по [payload] не пересчитывался бы. Список небольшой — это дёшево.
  const domains: string[] = [],
    ips: string[] = [],
    keywords: string[] = [],
    other: string[] = []
  for (const raw of payload) {
    const L = String(raw).trim()
    if (/^DOMAIN-KEYWORD,/i.test(L)) keywords.push(L)
    else if (/^DOMAIN(-SUFFIX)?,/i.test(L)) domains.push(L)
    else if (/^IP-CIDR6?,/i.test(L)) ips.push(L)
    else if (behavior === 'domain' && !L.includes(',')) domains.push(L)
    else if (behavior === 'ipcidr' && !L.includes(',')) ips.push(L)
    else other.push(L)
  }

  function removeLine(line: string) {
    const i = payload.indexOf(line)
    if (i >= 0) payload.splice(i, 1)
    rerender()
  }

  function addEntry(kind: 'domain' | 'ip' | 'keyword', value: string) {
    const v = value.trim()
    if (!v) return
    let entry: string
    if (behavior === 'domain' && kind === 'domain') entry = v.replace(/^DOMAIN-SUFFIX,|^\+\./i, '')
    else if (behavior === 'ipcidr' && kind === 'ip') {
      entry = v.replace(/^IP-CIDR6?,/i, '')
      if (!entry.includes('/')) entry += '/32'
    } else if (/^(DOMAIN|IP-CIDR|DOMAIN-KEYWORD|DOMAIN-SUFFIX|PROCESS|GEOIP)/i.test(v)) entry = v
    else if (kind === 'ip') entry = 'IP-CIDR,' + (v.includes('/') ? v : v + '/32')
    else if (kind === 'keyword') entry = 'DOMAIN-KEYWORD,' + v
    else entry = 'DOMAIN-SUFFIX,' + v
    if (payload.includes(entry)) {
      showToast('Уже есть', 'error')
      return
    }
    payload.push(entry)
    rerender()
  }

  return (
    <div className="border-border bg-input-background rounded-xl border">
      <div className="border-border flex items-center justify-between gap-2 border-b px-4 py-3">
        <Input
          className="h-8 w-52 font-medium"
          defaultValue={name}
          onBlur={(e) => onRename(e.target.value.trim())}
        />
        <div className="flex items-center gap-2">
          <Select
            value={behavior}
            onValueChange={(v) => {
              rule.behavior = v
              rerender()
            }}
          >
            <SelectTrigger size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="classical">classical</SelectItem>
              <SelectItem value="domain">domain</SelectItem>
              <SelectItem value="ipcidr">ipcidr</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon-sm" className="text-red-400" onClick={onDelete}>
            <IconTrash size={14} />
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div className="border-border bg-background flex flex-wrap items-center gap-2.5 rounded-lg border px-3 py-2.5">
          <IconRoute size={16} className="text-orange-400 shrink-0" />
          <span className="text-sm font-medium">Маршрут:</span>
          <Select value={route ?? NO_ROUTE} onValueChange={onSetRoute}>
            <SelectTrigger size="sm" className="min-w-44 flex-1">
              <SelectValue placeholder="не привязан" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_ROUTE}>— не привязан —</SelectItem>
              {selectorNames.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
              <SelectItem value="DIRECT">DIRECT</SelectItem>
              <SelectItem value="REJECT">REJECT</SelectItem>
              {route && route !== 'DIRECT' && route !== 'REJECT' && !selectorNames.includes(route) && (
                <SelectItem value={route}>{route} (не найден!)</SelectItem>
              )}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground w-full text-xs leading-snug">
            {route
              ? `Трафик из списка идёт через «${route}» (правило RULE-SET в rules).`
              : 'Список ни к чему не привязан — выберите селектор, чтобы трафик через него пошёл.'}
          </span>
        </div>
        <PayloadSection title="🌐 Домены" items={domains} kind="domain" onAdd={addEntry} onRemove={removeLine} />
        <PayloadSection title="🔢 IP / CIDR" items={ips} kind="ip" onAdd={addEntry} onRemove={removeLine} />
        {behavior === 'classical' && (
          <PayloadSection title="🔍 Ключевые слова" items={keywords} kind="keyword" onAdd={addEntry} onRemove={removeLine} />
        )}
        {other.length > 0 && (
          <div>
            <h5 className="text-muted-foreground mb-2 text-xs font-semibold">⚙️ Прочие правила ({other.length})</h5>
            <div className="flex flex-wrap gap-2">
              {other.map((l) => (
                <Tag key={l} label={l} onRemove={() => removeLine(l)} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PayloadSection({
  title,
  items,
  kind,
  onAdd,
  onRemove,
}: {
  title: string
  items: string[]
  kind: 'domain' | 'ip' | 'keyword'
  onAdd: (kind: 'domain' | 'ip' | 'keyword', v: string) => void
  onRemove: (line: string) => void
}) {
  const [val, setVal] = useState('')
  const ph = kind === 'domain' ? 'example.com' : kind === 'ip' ? '1.2.3.0/24' : 'ключевое слово'
  function submit() {
    onAdd(kind, val)
    setVal('')
  }
  return (
    <div>
      <h5 className="mb-2 text-xs font-semibold">
        {title} <span className="text-muted-foreground font-normal">{items.length}</span>
      </h5>
      <div className="mb-2 flex flex-wrap gap-2">
        {items.length === 0 && <span className="text-muted-foreground text-xs italic">Пусто</span>}
        {items.map((l) => (
          <Tag key={l} label={l.replace(/^DOMAIN-SUFFIX,|^DOMAIN,|^IP-CIDR6?,|^DOMAIN-KEYWORD,/i, '')} onRemove={() => onRemove(l)} />
        ))}
      </div>
      <div className="flex gap-2">
        <Input className="h-8" placeholder={ph} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <Button size="sm" variant="outline" onClick={submit}>
          <IconPlus size={15} />
        </Button>
      </div>
    </div>
  )
}

function Tag({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="border-border bg-background inline-flex items-center gap-1.5 rounded-md border py-1 pr-1 pl-2.5 font-mono text-xs">
      {label}
      <button className="hover:text-red-400" onClick={onRemove}>
        <IconX size={13} />
      </button>
    </span>
  )
}

function LabeledInput({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-muted-foreground text-xs">{label}</label>
      <Input className="h-8" type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

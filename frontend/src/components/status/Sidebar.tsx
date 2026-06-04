import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  IconAdjustmentsAlt,
  IconBox,
  IconCpu,
  IconList,
  IconLogout,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconRefresh,
  IconSettings,
} from '@tabler/icons-react'
import { useEffect } from 'react'
import { apiCall, capitalize } from '../../lib/api'
import { syncClashApiPort, useAppContext } from '../../lib/store'
import { cn } from '../../lib/utils'

export type AppSection = 'config' | 'logs'

export function Sidebar({
  section,
  onChangeSection,
  onOpenCoreManage,
  onOpenSettings,
  onRefreshStatus,
  onLogout,
}: {
  section: AppSection
  onChangeSection: (s: AppSection) => void
  onOpenCoreManage: () => void
  onOpenSettings: () => void
  onRefreshStatus: () => void
  onLogout: () => void
}) {
  const { state, dispatch, showToast } = useAppContext({ includeSettings: true })
  const { serviceStatus, pendingText, currentCore, coreVersions, isConfigsLoading, version, isOutdatedCore, settings } = state
  const authEnabled = settings.authEnabled

  const isRunning = serviceStatus === 'running'
  const isPending = serviceStatus === 'pending' || serviceStatus === 'loading'

  useEffect(() => {
    const interval = setInterval(() => {
      if (state.serviceStatus !== 'pending') onRefreshStatus()
    }, 15000)
    return () => clearInterval(interval)
  }, [state.serviceStatus, onRefreshStatus])

  function setPending(text: string) {
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: text })
  }

  async function startService() {
    setPending('Запуск...')
    const result = await apiCall<any>('POST', 'control', { action: 'start' })
    showToast(result.success ? 'XKeen запущен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    dispatch({ type: 'SET_SERVICE_STATUS', status: result.success ? 'running' : 'stopped' })
    if (result.success) syncClashApiPort()
    onRefreshStatus()
  }

  async function stopService() {
    setPending('Остановка...')
    const result = await apiCall<any>('POST', 'control', { action: 'stop' })
    showToast(result.success ? 'XKeen остановлен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    onRefreshStatus()
  }

  async function restartService() {
    setPending('Перезапуск...')
    const result = await apiCall<any>('POST', 'control', { action: 'hardRestart' })
    showToast(result.success ? 'XKeen перезапущен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    dispatch({ type: 'SET_SERVICE_STATUS', status: result.success ? 'running' : 'stopped' })
    if (result.success) syncClashApiPort()
    onRefreshStatus()
  }

  const statusLabel = isRunning ? 'mihomo запущена' : serviceStatus === 'stopped' ? 'остановлена' : pendingText || 'Загрузка...'
  const dotColor = isRunning ? 'bg-green-500' : isPending ? 'bg-amber-400' : 'bg-red-500'

  const navItem = (active: boolean) =>
    cn(
      'flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-colors cursor-pointer',
      active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
    )

  return (
    <TooltipProvider delayDuration={500}>
      <aside className="border-border bg-card flex w-full shrink-0 flex-col gap-3 rounded-xl border p-3 md:w-56">
        <div className="flex items-center gap-2.5 px-1.5 py-1">
          <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-[9px] text-base font-medium">
            X
          </div>
          <span className="text-[15px] font-medium">XKeen UI</span>
        </div>

        <nav className="flex flex-col gap-1 md:flex-col">
          <div className={navItem(section === 'config')} onClick={() => onChangeSection('config')}>
            <IconAdjustmentsAlt className="size-[18px]" /> Конфигурация
          </div>
          <div className={navItem(section === 'logs')} onClick={() => onChangeSection('logs')}>
            <IconList className="size-[18px]" /> Логи
          </div>
          <div className={navItem(false)} onClick={onOpenCoreManage}>
            <IconCpu className="size-[18px]" /> Ядро
            {isOutdatedCore && (
              <span className="relative ml-auto flex">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-orange-400 opacity-75" />
                <span className="relative inline-flex size-1.75 rounded-full bg-orange-500" />
              </span>
            )}
          </div>
          <div className={navItem(false)} onClick={onOpenSettings}>
            <IconSettings className="size-[18px]" /> Настройки
          </div>
        </nav>

        <div className="mt-auto flex flex-col gap-2.5">
          <div className="border-border bg-input-background rounded-xl border p-2.5">
            {isConfigsLoading ? (
              <Skeleton className="h-16 w-full rounded-lg" />
            ) : (
              <>
                <div className="mb-2.5 flex items-center gap-2 px-0.5">
                  <span className={cn('size-2 rounded-full', dotColor)} />
                  <span className="text-[13px]">{statusLabel}</span>
                </div>
                <div className="flex gap-1.5">
                  {!isRunning ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 flex-1 text-green-500 hover:border-green-500/50 hover:text-green-400"
                          onClick={startService}
                          disabled={isPending}
                        >
                          {isPending ? <Spinner className="size-4" /> : <IconPlayerPlayFilled className="size-4" />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Запустить</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          className="text-destructive hover:text-destructive h-8 flex-1"
                          onClick={stopService}
                          disabled={isPending}
                        >
                          {isPending ? <Spinner className="size-4" /> : <IconPlayerStopFilled className="size-4" />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Остановить</TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="text-primary h-8 flex-1"
                        onClick={restartService}
                        disabled={isPending || !isRunning}
                      >
                        {isPending ? <Spinner className="size-4" /> : <IconRefresh className="size-4" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Перезапустить</TooltipContent>
                  </Tooltip>
                </div>
              </>
            )}
          </div>

          <div className="text-muted-foreground flex items-center justify-between px-1.5 text-xs">
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="flex items-center gap-1.5" onClick={onOpenCoreManage}>
                  <IconCpu className="size-3.5" /> {capitalize(currentCore)}
                  {coreVersions[currentCore] && <span className="text-muted-foreground/60">{coreVersions[currentCore]}</span>}
                </button>
              </TooltipTrigger>
              <TooltipContent>Управление ядром</TooltipContent>
            </Tooltip>
            <div className="flex items-center gap-2.5">
              <span className="flex items-center gap-1" aria-label="Версия XKeen UI">
                <IconBox className="size-3.5" /> {version || '—'}
              </span>
              {authEnabled && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button onClick={onLogout} aria-label="Выйти">
                      <IconLogout className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Выйти</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      </aside>
    </TooltipProvider>
  )
}

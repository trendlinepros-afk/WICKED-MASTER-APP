import { useState } from 'react'
import { Crop, Eye, FolderOpen, Keyboard, Mic, MonitorPlay, Video } from 'lucide-react'
import { inv, useRec } from '../store'
import type { AreaMode, Frac } from '../types'
import { areaFor, areaLabel } from '../lib/geometry'
import AreaEditor from './AreaEditor'
import HotkeyField from './HotkeyField'
import MicPicker from './MicPicker'
import ScreenMap from './ScreenMap'
import { btnSm, DbSlider, Keys, Row, Section, Segmented, Toggle } from './ui'

const AREA_OPTIONS: { id: AreaMode; label: string; hint: string }[] = [
  { id: 'workarea', label: 'Screen without taskbar', hint: 'The whole monitor minus the Windows taskbar' },
  { id: 'full', label: 'Entire screen', hint: 'Everything, taskbar included' },
  { id: 'custom', label: 'Custom area', hint: 'A part of the screen you draw yourself' }
]

export default function SettingsView(): React.JSX.Element {
  const s = useRec()
  const st = s.settings
  const scr = s.screens
  const screens = scr?.screens ?? []
  const def = screens.find((x) => x.id === s.machine.defaultScreenId)
  const [editing, setEditing] = useState<string | null>(null)
  const editScreen = screens.find((x) => x.id === editing)
  const customFor = (id: string): Frac | undefined => s.machine.customAreas[id]
  const areaText = (id: string): string => {
    const sc = screens.find((x) => x.id === id)
    if (!sc) return ''
    const custom = customFor(id)
    const mode: AreaMode = st.areaMode === 'custom' && !custom ? 'workarea' : st.areaMode
    return areaLabel(mode, areaFor(mode, sc, custom), sc.pixels)
  }
  const editTarget = def ?? screens.find((x) => x.primary) ?? screens[0]

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <h1 className="text-xl font-bold text-ink">Settings</h1>

        <Section icon={<Keyboard size={16} />} title="Record hotkey" sub="Starts and stops a clip from any app while WICKED is open (it can be minimised).">
          <HotkeyField />
          <div className="mt-3 border-t border-edge pt-1">
            <Toggle checked={st.hotkeyEnabled} onChange={(v) => void s.saveSettings({ hotkeyEnabled: v })} label="Hotkey on" hint={<>While it’s on, {<Keys accel={s.hotkey.accelerator} />} belongs to ScreenRec in every program — e.g. browsers won’t refresh with it (F5 still works).</>} />
          </div>
        </Section>

        <Section
          icon={<MonitorPlay size={16} />}
          title="Screen to record"
          sub={def ? <>With a default screen, {<Keys accel={s.hotkey.accelerator} />} starts recording it immediately.</> : <>{<Keys accel={s.hotkey.accelerator} />} shows a picker on your monitors — click one (or press its number), then press {<Keys accel="R" />} to start.</>}
          right={
            <button className={btnSm} onClick={() => void inv('identify')} title="Show each monitor's number on screen">
              <Eye size={12} /> Identify
            </button>
          }
        >
          {screens.length > 0 && <ScreenMap screens={screens} selected={s.machine.defaultScreenId} onSelect={(id) => void s.saveMachine({ defaultScreenId: id === s.machine.defaultScreenId ? '' : id })} areaText={areaText} />}
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input type="radio" checked={!s.machine.defaultScreenId} onChange={() => void s.saveMachine({ defaultScreenId: '' })} className="accent-accent" />
            Ask me every time
          </label>
          {screens.length > 0 && (
            <div className="mt-1 text-xs text-muted">{def ? `Default: Screen ${def.number} · ${def.label}. Click it again (or “Ask me every time”) to clear.` : 'Click a monitor to make it the default.'}</div>
          )}
        </Section>

        <Section icon={<Crop size={16} />} title="What to capture" sub="The final video is 1920×1080 either way.">
          <Segmented value={st.areaMode} options={AREA_OPTIONS} onChange={(v) => void s.saveSettings({ areaMode: v })} />
          <p className="mt-2 text-xs text-muted">{AREA_OPTIONS.find((o) => o.id === st.areaMode)?.hint}.</p>
          {st.areaMode === 'custom' && (
            <div className="mt-3 space-y-2">
              {screens.map((sc) => (
                <div key={sc.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-bg px-3 py-2 text-sm">
                  <span className="font-semibold text-ink">Screen {sc.number}</span>
                  <span className="text-muted">{sc.label}</span>
                  <span className="flex-1 text-xs text-muted">{customFor(sc.id) ? areaText(sc.id) : 'no custom area yet — records without the taskbar'}</span>
                  <button className={btnSm} onClick={() => setEditing(sc.id)}>
                    {customFor(sc.id) ? 'Edit area' : 'Draw area'}
                  </button>
                </div>
              ))}
            </div>
          )}
          {st.areaMode !== 'custom' && editTarget && (
            <div className="mt-2 text-xs text-muted">
              Screen {editTarget.number}: {areaText(editTarget.id)}
            </div>
          )}
        </Section>

        <Section icon={<Mic size={16} />} title="Audio" sub="What goes into every clip.">
          <MicPicker gainDb={st.micGainDb} />
          <div className="mt-3">
            <div className="mb-1 text-sm text-ink">Microphone volume</div>
            <DbSlider value={st.micGainDb} min={-12} max={12} onChange={(v) => void s.saveSettings({ micGainDb: v })} />
          </div>
          <div className="mt-2 divide-y divide-edge border-t border-edge">
            <Toggle checked={st.noiseSuppression} onChange={(v) => void s.saveSettings({ noiseSuppression: v })} label="Reduce background noise" hint="Filters fans, hum and keyboard clatter. Leave off for a good mic in a quiet room." />
            <Toggle checked={st.systemAudio} onChange={(v) => void s.saveSettings({ systemAudio: v })} label="Also record computer sound" hint="Everything you hear (videos, games, notifications) is mixed in with your voice." />
          </div>
        </Section>

        <Section icon={<Video size={16} />} title="Recording">
          <div className="divide-y divide-edge">
            <Row title="Frame rate" hint="60 fps for games and fast motion; 30 fps is plenty for tutorials.">
              <Segmented value={st.fps} options={[{ id: 30, label: '30 fps' }, { id: 60, label: '60 fps' }]} onChange={(v) => void s.saveSettings({ fps: v })} />
            </Row>
            <Row title="Recording quality" hint="High keeps small text crisp; Standard makes smaller raw files.">
              <Segmented value={st.quality} options={[{ id: 'standard', label: 'Standard' }, { id: 'high', label: 'High' }]} onChange={(v) => void s.saveSettings({ quality: v })} />
            </Row>
            <Row title="Countdown before recording">
              <Segmented value={st.countdown} options={[{ id: 0, label: 'Off' }, { id: 3, label: '3 s' }, { id: 5, label: '5 s' }]} onChange={(v) => void s.saveSettings({ countdown: v })} />
            </Row>
            <Toggle checked={st.indicator} onChange={(v) => void s.saveSettings({ indicator: v })} label="Show a REC timer while recording" hint="A small pill at the top of the recorded screen. It is hidden from the video itself (Windows 10 2004 or newer)." />
          </div>
        </Section>

        <Section icon={<FolderOpen size={16} />} title="Folders">
          <div className="divide-y divide-edge">
            {(
              [
                ['output', 'Finished videos', s.paths.outputDir, st.outputDir],
                ['raw', 'Raw clips', s.paths.rawDir, st.rawDir]
              ] as const
            ).map(([which, title, path, custom]) => (
              <div key={which} className="flex flex-wrap items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink">{title}</div>
                  <div className="truncate text-xs text-muted" title={path}>
                    {path}
                  </div>
                </div>
                <button className={btnSm} onClick={() => void inv('open-folder', which)}>
                  Open
                </button>
                <button className={btnSm} onClick={() => void inv('choose-dir', which)}>
                  Change…
                </button>
                {custom && (
                  <button className={btnSm} onClick={() => void inv('reset-dir', which)}>
                    Default
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Raw clips stay on this PC (they aren’t part of WICKED Backup / Cloud Sync). Screen and microphone choices are remembered per PC.</p>
        </Section>
      </div>
      {editScreen && (
        <AreaEditor
          screen={editScreen}
          initial={customFor(editScreen.id) ?? areaFor('workarea', editScreen)}
          lock169={st.lock169}
          onClose={() => setEditing(null)}
          onSave={(f, lock) => {
            setEditing(null)
            void s.saveMachine({ customAreas: { ...s.machine.customAreas, [editScreen.id]: f } })
            if (lock !== st.lock169 || st.areaMode !== 'custom') void s.saveSettings({ lock169: lock, areaMode: 'custom' })
          }}
        />
      )}
    </div>
  )
}


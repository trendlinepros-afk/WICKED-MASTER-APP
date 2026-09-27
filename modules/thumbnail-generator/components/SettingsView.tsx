import { useEffect, useState } from 'react'
import { Coins, FolderOpen, KeyRound, RefreshCw } from 'lucide-react'
import { inv, useThumbs } from '../store'
import { fmtUsd, MODELS } from '../lib/models'
import { btn, card, inputSm, label } from './ui'

export default function SettingsView(): React.JSX.Element {
  const s = useThumbs()
  const st = s.settings
  const [dir, setDir] = useState('')
  useEffect(() => {
    void (inv('download-dir') as Promise<string>).then(setDir)
  }, [st.downloadDir])
  const perCredit = st.planPrice > 0 && st.planCredits > 0 ? st.planPrice / st.planCredits : null
  const num = (v: string): number => Math.max(0, Number(v) || 0)
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <h1 className="text-xl font-bold text-ink">Settings</h1>

        <section className={`${card} p-5`}>
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
            <KeyRound size={15} className="text-accent" /> Pikzels API key
          </div>
          <p className="text-xs text-muted">
            {s.hasKey ? 'A key is set in the WICKED vault.' : 'No key yet.'} Keys live in <b>Settings → API Keys → Pikzels</b> (never inside this module).
          </p>
          <button className={`${btn} mt-2`} onClick={() => void s.refreshKey()}>
            <RefreshCw size={13} /> Re-check
          </button>
        </section>

        <section className={`${card} p-5`}>
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
            <FolderOpen size={15} className="text-accent" /> Download folder
          </div>
          <p className="mb-2 text-xs text-muted">Every generated or edited thumbnail is written here the moment Pikzels returns it.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-raised px-2 py-1.5 text-xs text-ink">{dir}</code>
            <button className={btn} onClick={() => void (inv('choose-download-dir') as Promise<typeof st>).then((v) => useThumbs.setState({ settings: v }))}>
              Change…
            </button>
            {st.downloadDir && (
              <button className={btn} onClick={() => void s.saveSettings({ downloadDir: '' })}>
                Use Downloads
              </button>
            )}
            <button className={btn} onClick={() => void inv('open', { folder: true })}>
              Open
            </button>
          </div>
        </section>

        <section className={`${card} p-5`}>
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
            <Coins size={15} className="text-accent" /> Credits & cost estimate
          </div>
          <p className="mb-3 text-xs text-muted">
            Pikzels charges 10–20 credits per thumbnail depending on the model and your plan. These figures drive the estimate in the top-right of Create; when a
            Pikzels response reports the credits it used, the matching model is updated automatically.
            {st.creditsRemaining != null && (
              <>
                {' '}
                Last reported balance: <b className="text-ink">{st.creditsRemaining.toLocaleString()} credits</b>.
              </>
            )}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {MODELS.map((m) => (
              <label key={m.id} className="text-xs text-muted">
                {m.label}
                <div className="mt-1 flex items-center gap-1">
                  <input type="number" min={0} value={st.creditsPerModel[m.id]} onChange={(e) => void s.saveSettings({ creditsPerModel: { ...st.creditsPerModel, [m.id]: num(e.target.value) } })} className={`${inputSm} w-20`} />
                  <span>cr</span>
                </div>
              </label>
            ))}
            {(
              [
                ['creditsPersona', 'Persona training'],
                ['creditsStyle', 'Theme training'],
                ['creditsTitle', 'Titles'],
                ['creditsScore', 'Score'],
                ['creditsEdit', 'Edit']
              ] as const
            ).map(([k, lbl]) => (
              <label key={k} className="text-xs text-muted">
                {lbl}
                <div className="mt-1 flex items-center gap-1">
                  <input type="number" min={0} value={st[k]} onChange={(e) => void s.saveSettings({ [k]: num(e.target.value) })} className={`${inputSm} w-20`} />
                  <span>cr</span>
                </div>
              </label>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className={label}>Your plan: $ per month</label>
              <input type="number" min={0} step="0.01" value={st.planPrice || ''} placeholder="e.g. 39" onChange={(e) => void s.saveSettings({ planPrice: num(e.target.value) })} className={`${inputSm} w-full`} />
            </div>
            <div>
              <label className={label}>Credits included per month</label>
              <input type="number" min={0} value={st.planCredits || ''} placeholder="e.g. 1000" onChange={(e) => void s.saveSettings({ planCredits: num(e.target.value) })} className={`${inputSm} w-full`} />
            </div>
            <div>
              <label className={label}>Works out to</label>
              <div className="rounded-md border border-edge bg-raised px-2 py-1 text-sm text-ink">{perCredit != null ? `${fmtUsd(perCredit)} per credit · ${fmtUsd(perCredit * st.creditsPerModel.pkz_4_5)} per PKZ 4.5 thumbnail` : 'enter both to see $ figures'}</div>
            </div>
          </div>
        </section>

        <section className={`${card} p-5`}>
          <div className="mb-1 text-sm font-semibold text-ink">Generation</div>
          <label className="flex items-center justify-between gap-3 text-sm text-ink">
            <span>
              Parallel generations
              <span className="block text-xs text-muted">How many thumbnails of a batch are requested at once.</span>
            </span>
            <select value={st.concurrency} onChange={(e) => void s.saveSettings({ concurrency: Number(e.target.value) })} className={inputSm}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className={`${card} p-5 text-xs text-muted`}>
          <div className="mb-1 text-sm font-semibold text-ink">Personas & themes on other PCs</div>
          Your library (names, ids, previews, special-instruction history) is stored with WICKED’s module data, which Backup and Cloud Sync carry to every PC you sign
          in on. Something trained on another machine before a sync can be added with <b>Library → Add existing by id</b>.
        </section>
      </div>
    </div>
  )
}

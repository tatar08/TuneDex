'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { strings } from '@/lib/i18n';
import { ExplorerIcon } from '../ExplorerUI';
import { usePlayer } from './Player';

/** The reference's three-part player, with actual media time/volume and no fabricated live seek bar. */
export function ExplorerPlayerBar() {
  const { now, status, lang, stop, togglePlayback, muted, toggleMute, volume, setVolume, elapsed } = usePlayer();
  const [message,setMessage] = useState('');
  const dialog=useRef<HTMLDialogElement>(null);
  const [timer,setTimer]=useState(0);
  useEffect(()=>{if(!timer)return;const id=setTimeout(()=>{stop();setTimer(0)},timer*60_000);return()=>clearTimeout(id)},[timer,stop]);
  const t=strings(lang),th=lang==='th';
  const paused=status==='paused';
  const state=status==='failed'?t.playerFailed:paused?(th?'พักการเล่น':'Paused'):status==='playing'?t.playerPlaying:t.playerConnecting;
  const share=async()=>{if(!now)return;try{await navigator.clipboard.writeText(now.url);setMessage(th?'คัดลอกลิงก์แล้ว':'Link copied');}catch{setMessage(th?'คัดลอกไม่ได้':'Cannot copy link');}};
  return <><section className="explorer-player" data-testid={now?'player':undefined} data-state={now?status:'idle'} aria-label={now?t.playerNow(now.name):(th?'ตัวเล่น':'Player')}>
    <div className="explorer-player-left"><span className="explorer-player-art" aria-hidden="true">{now?.name.trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase() ?? '♫'}</span><div><button type="button" className="atlas-player-open" aria-label={th?'เปิดเครื่องเล่นเต็ม':'Open full player'} onClick={()=>dialog.current?.showModal()}><b>{now?.name ?? (th?'ยังไม่ได้เล่นสถานี':'Nothing playing')}</b><span role={status==='failed'?'alert':'status'}>{now?state:(th?'เลือกสถานี แล้วกดเล่น':'Choose a station and press Play')}</span></button></div></div>
    <div className="explorer-player-center"><button type="button" className="explorer-player-toggle" disabled={!now} onClick={togglePlayback} aria-label={th?(status==='playing'?'พักการเล่น':'เล่นต่อ'):(status==='playing'?'Pause':'Resume')}><svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">{status==='playing'?<><rect x="7" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></>:<path d="m8 5 11 7-11 7Z"/>}</svg></button><div className="explorer-live-readout"><time>{String(Math.floor(elapsed/60)).padStart(2,'0')}:{String(Math.floor(elapsed%60)).padStart(2,'0')}</time><span className="explorer-live-line" aria-hidden="true"/><b>{now?(th?'สตรีม':'STREAM'):'—'}</b></div></div>
    <div className="explorer-player-right"><button type="button" onClick={toggleMute} aria-label={th?(muted?'เปิดเสียง':'ปิดเสียง'):(muted?'Unmute':'Mute')} aria-pressed={muted}><ExplorerIcon kind={muted?'muted':'volume'}/></button><input aria-label={th?'ระดับเสียง':'Volume'} type="range" min="0" max="1" step="0.05" value={volume} onChange={e=>setVolume(Number(e.target.value))}/><button type="button" onClick={()=>void share()} disabled={!now} aria-label={th?'คัดลอกลิงก์สถานี':'Copy station link'}><ExplorerIcon kind="share"/></button><Link href="/app/radio?library=1" prefetch={false} aria-label={t.homeManage}><ExplorerIcon kind="heart"/></Link>{now&&<button type="button" onClick={stop} aria-label={t.playerStop}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg></button>}</div>
    {message&&<span className="explorer-player-notice" role="status">{message}<button type="button" onClick={()=>setMessage('')} aria-label={th?'ปิดข้อความ':'Dismiss'}>×</button></span>}
  </section>
  <dialog ref={dialog} className="atlas-dialog atlas-player-dialog" aria-label={th?'กำลังฟัง':'Now listening'}>
   <button type="button" className="atlas-dialog-close" aria-label={th?'ปิดเครื่องเล่น':'Close player'} onClick={()=>dialog.current?.close()}><ExplorerIcon kind="close"/></button>
   <span className="atlas-detail-art" aria-hidden="true">{now?.name.slice(0,2).toUpperCase()??'♫'}</span><h2>{now?.name??(th?'ยังไม่ได้เล่นสถานี':'Nothing playing')}</h2><p role="status">{now?state:(th?'เลือกสถานีแล้วกดเล่น':'Choose a station and press Play')}</p>
   <div className="explorer-player-right"><button type="button" disabled={!now} aria-label={th?(status==='playing'?'พักการเล่น':'เล่นต่อ'):(status==='playing'?'Pause':'Resume')} onClick={togglePlayback}><span aria-hidden="true">{status==='playing'?'Ⅱ':'▶'}</span></button><button type="button" aria-label={th?(muted?'เปิดเสียง':'ปิดเสียง'):(muted?'Unmute':'Mute')} onClick={toggleMute} aria-pressed={muted}><ExplorerIcon kind={muted?'muted':'volume'}/></button><input type="range" aria-label={th?'ระดับเสียง':'Volume'} min="0" max="1" step="0.05" value={volume} onChange={e=>setVolume(Number(e.target.value))}/><button type="button" disabled={!now} aria-label={th?'คัดลอกลิงก์สถานี':'Copy station link'} onClick={()=>void share()}><ExplorerIcon kind="share"/></button>{now&&<button type="button" aria-label={t.playerStop} onClick={stop}>■</button>}</div>
   <label className="atlas-timer">{th?'ตั้งเวลาหยุด':'Sleep timer'}<select value={timer} onChange={e=>setTimer(Number(e.target.value))}><option value={0}>{th?'ปิด':'Off'}</option>{[15,30,60].map(m=><option key={m} value={m}>{m} {th?'นาที':'minutes'}</option>)}</select></label>
   <Link href="/app/radio?library=1" prefetch={false} onClick={()=>dialog.current?.close()}>{t.homeManage}</Link>
   {message&&<p role="status">{message}</p>}
  </dialog></>;
}

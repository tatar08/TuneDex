# Android Auto and Internet Radio

Owner: Android/native media + Flutter lead · Revision 0.2 · R1 required scope

## Internet radio product contract

เล่นสถานีผ่าน internet streaming MP3/AAC/HLS ที่ engine รองรับ; ผู้ใช้เพิ่ม URL/playlist เอง หรือเลือก approved catalog. สถานีต้องมี name, country/language/genre optional, logo with rights, stream variants, bitrate hint, availability timestamp. ICY title/artist เป็น optional metadata ไม่รับประกันทุกสถานี

มี search/filter/favorite/recent และ retry เมื่อสัญญาณขาด. Data saver เลือก lower bitrate **เฉพาะเมื่อมี variant ที่สถานีให้จริง** ไม่อ้างว่าเราลด bitrate/transcode เอง. ก่อนเลือก cellular แสดงว่าใช้ mobile data; ประมาณ MB/hour = bitrate(kbps) × 3600 / 8 / 1000 ไม่รวม protocol overhead (128kbps ≈57.6MB/hour)

ไม่ใช่ FM/AM hardware, ไม่บันทึก/ดาวน์โหลดฟัง offline ใน R1. Offline แสดง cache และ unavailable play; server outage ไม่ควรหยุด stream ตรงที่ยังเข้าถึงต้นทางได้. Station token/credentials ของผู้ใช้เก็บเฉพาะ device

## Android integration

Flutter ส่ง intent ผ่าน typed bridge; Kotlin `MediaLibraryService` ถือ ExoPlayer/MediaSession และ browse callbacks. Android Auto host วาด UI media ของตัวเองจาก library ไม่ mirror Flutter widgets. เลือก classic media-library path ใน R1; templates เพิ่มเติมเป็น future evaluation ไม่ผูก beta capability กับ release หลัก

Manifest/service declaration, foreground media playback permission/type, media notification, media button handling และ allowed controller policies ต้องตรง target SDK ปัจจุบัน. Check controller identity ด้วย framework-supported trust validation/official signatures ตาม implementation guide ไม่เชื่อ package name string อย่างเดียว; trusted system/car clients ได้เฉพาะ browse/play actions ไม่ใช้ service เป็น admin API

Browse root: Favorites / Recent / Radio → Categories → Stations แบบ paged bounded list. IDs stable/opaque ไม่ใช้ stream URL เป็น media ID. No typing/login/paywall หรือ purchase flow ในรถ; setup ที่มือถือก่อน. Search/voice intent คืนเฉพาะ eligible audio และ graceful no-result

Native session อ่าน atomic snapshot และ secure endpoints โดยไม่ต้องเปิด Flutter Activity. Android Auto cold start ใช้ cached approved catalog/favorites ได้; ไม่มี snapshot ให้ “ตั้งค่าบนโทรศัพท์”. Service recreation ไม่ autoplay เอง ยกเว้น explicit authorized playback-resumption intent

## Lifecycle matrix

| Event | Expected |
|---|---|
| Phone UI ถูก swipe ออกระหว่างเล่น | service behavior ตาม OS/lifecycle ที่ทดสอบ; session ไม่ผูก Activity |
| OS ฆ่า process | no guarantee uninterrupted audio; user-triggered resume อ่าน snapshot ได้ |
| User force-stop | เคารพ OS stop; ไม่ปลุก app เพื่อเลี่ยง force-stop |
| Call / transient audio-focus loss | pause/duck ตาม focus event และ source policy |
| Focus regain หลัง user pause | remain paused |
| Wired/wireless disconnect → speaker | pause, no speaker auto-resume |
| Wi-Fi→cellular | bounded recovery; respect cellular preference |
| Login token expired / backend down | public cached radio playback ยังทำงาน; sync pending |
| User/device revoked server-side | หยุด sync/new private API access; public local radio ไม่ถูก remote-stop |
| Catalog station disabled | refresh browse status; ห้าม admin force-play/re-route active session |

## SP-06 Android Auto prototype

Timebox 3–5 engineering days after Android toolchain/phone/DHU available. Deliver Flutter app with Kotlin media service, one owned radio fixture, native cached Favorites root, notification/lock screen controls and Auto browse/play without UI Activity

Pass evidence: DHU + actual supported head unit, service cold start, phone lock, task removal, process death/user resume, audio focus, network recovery, rapid switching and token expiry. ขาดรถทดสอบ = blocked real-car gate ไม่ถือ DHU แทนครบ. [Google DHU guide](https://developer.android.com/training/cars/testing/dhu)

## SP-07 Internet radio compatibility

MP3 continuous, AAC continuous, HLS audio, ICY absent/change/malformed, redirect/401/403/429, multiple bitrates, origin timeout, server down. ตรวจบน iOS AVPlayer และ Android Media3; ที่ engine ทำไม่ได้ให้ precise unsupported/metadata fallback. station health ในเว็บแสดงผล test แยก region/platform ไม่ลบช่องเพราะ client เดียว fail

Targets เดิม startup ≤3s p95, recovery ≤8s p95 หลัง network กลับบน declared fixtures; thermal/energy 2h soak ทั้งสอง OS. Android baseline proposed 4GB RAM Android 10+ และ current version บนอย่างน้อยสอง OEM เพื่อเช็ค background restrictions

## Scope boundary and release

Android Auto = phone projected media. AAOS built-in, Android TV และ car video browser ยังไม่อยู่ R1. CarPlay video R2 ไม่หมายความว่า Android Auto video ทำได้แบบเดียวกัน; ต้อง separate platform research ถ้าเพิ่มภายหลัง

T-AUTO real-device matrix และ current Google car app quality/store checks เป็น gate; request/approve scope reduction ก่อนตัด Android Auto จาก full requested release. Reviewer/demo ใช้ legal fixtures และ behavior เดียวกับ production

อ้างอิง platform path: [Android media apps for cars](https://developer.android.com/training/cars/media), [Media browser service](https://developer.android.com/training/cars/media/create-media-browser), [Media3 background playback](https://developer.android.com/media/media3/session/background-playback)

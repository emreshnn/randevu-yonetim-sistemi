# 💈 Baloğlu Erkek Saç Tasarım Merkezi — Randevu Sistemi

## 🚀 Kurulum (3 Adım)

### 1. Node.js Yükle
https://nodejs.org adresinden Node.js LTS indir ve kur.

### 2. Bağımlılıkları Yükle
Bu klasörü bir terminalde aç ve çalıştır:
```
npm install
```

### 3. Sistemi Başlat
```
npm start
```

---

## 🌐 Adresler

| Sayfa | Adres |
|-------|-------|
| Müşteri Randevu Sayfası | http://localhost:3000 |
| Admin Paneli | http://localhost:3000/admin |

**Admin Şifresi:** `admin123` (İlk girişte değiştirin!)

---

## 📱 WhatsApp Kurulumu

1. `npm start` ile sistemi başlat
2. Terminalde QR kodu görünecek
3. Telefonunda WhatsApp → Bağlı Cihazlar → Cihaz Bağla
4. QR kodu okut → Bağlantı kuruldu ✅

Bir kez bağlandıktan sonra tekrar QR okutmanız gerekmez.

**Admin panelinden** de QR kodu görebilirsiniz: Admin → WhatsApp menüsü

---

## ✨ Özellikler

### Müşteri Tarafı
- 5 adımlı randevu sihirbazı
- Hizmet seçimi (fiyat + süre görünür)
- Berber seçimi (fark etmez seçeneği dahil)
- Takvim ile tarih seçimi (kapalı günler gri)
- Müsait saat dilimleri
- WhatsApp bilgilendirmesi

### Admin Paneli
- **Dashboard:** Bekleyen, bugün, onaylı, haftalık istatistikler
- **Randevular:** Filtrele, onayla, reddet
- **Bugün:** Günlük randevu listesi
- **Personel:** Ekle/düzenle/pasife al
- **Hizmetler:** Ekle/düzenle/fiyat/süre
- **Çalışma Saatleri:** Her gün için açılış-kapanış, tatil günleri
- **WhatsApp:** QR bağlantısı, durum takibi
- **Ayarlar:** Dükkan bilgileri, şifre değiştir

### Otomatik WhatsApp Mesajları
- Randevu **onaylandığında** müşteriye otomatik WP mesajı
- Randevu **reddedildiğinde** bilgilendirme mesajı
- WA bağlı değilse manuel gönderim linki (tek tıkla)

---

## ⚙️ Hosting (İnternete Yayınlama)

**Seçenek 1 - Railway.app (Ücretsiz)**
1. https://railway.app → GitHub ile giriş
2. "Deploy from GitHub" → Bu klasörü yükle
3. Otomatik yayınlanır

**Seçenek 2 - VPS/Sunucu**
```bash
# PM2 ile arka planda çalıştır
npm install -g pm2
pm2 start server.js --name baloglu-randevu
pm2 startup
pm2 save
```

---

## 📋 Varsayılan Veriler

### Personel (değiştirilebilir)
- Ahmet Usta (Baş Berber)
- Mehmet Usta (Berber)
- Ali Usta (Berber)
- Hasan Usta (Berber)

### Hizmetler (değiştirilebilir)
- Saç Kesimi — 30dk — ₺150
- Sakal Düzeltme — 20dk — ₺100
- Saç + Sakal — 45dk — ₺220
- Saç Yıkama — 15dk — ₺80
- Fön — 20dk — ₺100
- Ense Tıraşı — 10dk — ₺60
- Kaş Alma — 10dk — ₺50
- Komple Bakım — 75dk — ₺350

---

Sorun için: Sistemin terminalde verdiği hata mesajlarına bakın.

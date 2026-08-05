# Randevu Yönetim Sistemi

Kuaför, berber ve benzeri randevu ile çalışan işletmeler için geliştirilmiş, uçtan uca online randevu ve yönetim sistemi. Müşteri tarafında çok adımlı bir randevu akışı, işletme tarafında ise tam kapsamlı bir yönetim paneli sunar.

## Özellikler

**Müşteri tarafı**
- Hizmet → personel → tarih → saat sırasıyla ilerleyen 4 adımlı randevu akışı
- Seçilen personelin çalışma saatlerine ve mevcut randevularına göre gerçek zamanlı müsaitlik hesaplama
- Mobil öncelikli, tamamen responsive arayüz

**Yönetim paneli**
- Randevu yönetimi: onaylama, iptal, takvim ve liste görünümü
- Personel yönetimi: personel bazlı çalışma saatleri ve izin günleri
- Hizmet yönetimi: süre ve fiyat tanımlama
- İşletme ayarları ve şifre değiştirme
- Bildirim entegrasyonu ayarları

**Otomasyon**
- Randevu onayında otomatik WhatsApp bildirimi
- Randevudan 12 saat önce otomatik hatırlatma mesajı (`node-cron` ile zamanlanmış görev)
- Twilio WhatsApp API ve WhatsApp Web olmak üzere iki farklı gönderim kanalı
- QR kod üretimi

## Teknolojiler

| Katman | Kullanılan |
|---|---|
| Sunucu | Node.js, Express.js |
| Veritabanı | SQLite (`better-sqlite3`) |
| Kimlik doğrulama | `express-session`, `bcryptjs` ile hash'lenmiş parola |
| Zamanlanmış görevler | `node-cron` |
| Bildirim | Twilio WhatsApp API, `whatsapp-web.js` |
| Diğer | `qrcode`, `moment`, `multer` |

Yaklaşık 1.200 satırlık tek dosyalık REST API (`server.js`) ve saf HTML/CSS/JavaScript ile yazılmış istemci arayüzü içerir; frontend'de herhangi bir framework kullanılmamıştır.

## Kurulum

```bash
npm install
npm start
```

| Sayfa | Adres |
|---|---|
| Müşteri randevu sayfası | http://localhost:3000 |
| Yönetim paneli | http://localhost:3000/admin |

Veritabanı ilk çalıştırmada otomatik oluşturulur ve örnek hizmet/personel verisiyle doldurulur.

> **Varsayılan yönetici parolası `admin123`'tür ve ilk girişte değiştirilmelidir.** Parola veritabanında bcrypt ile hash'lenerek saklanır.

## Proje Yapısı

```
server.js           REST API, veritabanı şeması, zamanlanmış görevler, bildirim servisleri
public/index.html   Müşteri randevu arayüzü
public/admin.html   Yönetim paneli
KURULUM.md          Son kullanıcı için kısa kurulum kılavuzu
```

## Yapılandırma

| Ortam değişkeni | Açıklama |
|---|---|
| `SESSION_SECRET` | Oturum imzalama anahtarı. Tanımlanmazsa ilk çalıştırmada rastgele üretilip veritabanında saklanır. Üretimde tanımlanması önerilir. |
| `PORT` | Sunucu portu (varsayılan: 3000) |

## Notlar

- WhatsApp oturum verisi (`wa-session/`) ve veritabanı dosyaları bilinçli olarak depoya dahil edilmemiştir.
- Twilio bilgileri kod içinde tutulmaz; yönetim panelinden girilir ve veritabanında saklanır.
- Oturum anahtarı, yönetici parolası ve bildirim anahtarları `/api/admin/settings` yanıtından ayıklanır; istemciye hiçbir zaman gönderilmez.

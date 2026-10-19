# TempMail — celana-ar-store.my.id

Layanan email sementara ala temp-mail.org, jalan 100% gratis di Cloudflare Workers + Email Routing. Tanpa kartu kredit.

## Cara kerja

1. Email masuk ke alamat apapun `@celana-ar-store.my.id`
2. Cloudflare Email Routing meneruskan ke Worker ini (`email()` handler)
3. Worker menyimpan email ke KV (otomatis terhapus setelah 2 jam)
4. Web inbox menampilkan email per alamat, auto-refresh tiap 5 detik

## Setup (sekali saja)

### 1. Buat KV namespace
- Buka dash.cloudflare.com → **Workers & Pages** → **KV** → **Create a namespace**
- Nama bebas, misal `tempmail-inbox` → **Add**
- Salin **ID**-nya → tempel di `wrangler.toml` menggantikan `GANTI_DENGAN_KV_NAMESPACE_ID`

### 2. Tambah secrets ke repo ini
- GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
  - `CLOUDFLARE_API_TOKEN` (token dengan izin Workers + Zone)
  - `CLOUDFLARE_ACCOUNT_ID` (ada di dashboard Cloudflare)
- Tiap push ke `main` otomatis deploy via GitHub Actions

### 3. Pasang custom domain
- Dashboard Worker `celana-ar-tempmail` → **Settings** → **Domains & Routes** → **Add Custom Domain**
- Misal: `mail.celana-ar-store.my.id`
- (Alternatif: uncomment blok `[[routes]]` di `wrangler.toml`)

### 4. Arahkan Email Routing ke Worker
- Domain `celana-ar-store.my.id` → **Email** → **Email Routing** → **Routing rules**
- **Catch-all** → **Edit** → Action: **Send to a Worker** → pilih `celana-ar-tempmail` → **Save**
- Catatan: catch-all yang tadinya forward ke Gmail akan diganti. Kalau mau keduanya,
  buat rule spesifik per alamat penting (misal `admin@`) dengan action "Send to an email",
  dan biarkan catch-all ke Worker.

## File

| File | Fungsi |
|------|--------|
| `worker.js` | Email receiver + parser MIME ringan + web inbox + API |
| `wrangler.toml` | Konfigurasi Worker & KV binding |
| `.github/workflows/deploy.yml` | Auto-deploy tiap push ke `main` |

## API

- `GET /api/inbox?address=email@domain` → daftar email (maks 50)
- `GET /api/read?address=email@domain&id=xxx` → isi lengkap satu email
- `DELETE /api/delete?address=email@domain&id=xxx` → hapus satu email manual

## Batasan

- Email terhapus otomatis setelah 2 jam — jangan untuk hal penting
- Isi email dipotong 20.000 karakter, raw dibaca maks 512 KB
- Hanya menerima, tidak bisa mengirim email

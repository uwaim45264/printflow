# PrintFlow

QR-based file sharing for print shops. A customer scans a shop's QR code, uploads documents from their phone (no account), and the shop owner downloads, prints and tracks the order from their dashboard.

**Backend: Supabase database + Storage.** PrintFlow keeps its own users and sessions in the database (`printflow_users`, `printflow_sessions`); Supabase Auth is **not** used. All tables, functions and the Storage bucket are prefixed `printflow`, so the app can share a Supabase project with other apps.

## Setup

Requires **Node.js 20.19+** and a Supabase project (free tier is fine).

1. **Install:** `npm install`
2. **Configure:** copy `.env.example` to `.env`. Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from **Dashboard → Project Settings → API**.
3. **Create the database:** in **Dashboard → SQL Editor**, run each file in `supabase/migrations/` in name order (paste → Run): `…_printflow_init.sql`, `…_admin_account.sql`, `…_direct_file_access.sql`, `…_page_options.sql`.
4. **(Optional) file function:** files are opened straight from Storage. The `printflow-files` Edge Function is only a fallback; deploy it with `npx supabase functions deploy printflow-files --no-verify-jwt --project-ref <your-ref>` if you want it.
5. **Create the Super Admin.** Pick one:
   - In the SQL Editor: `select printflow_svc_create_super_admin('superadmin', 'YourPassword123');`
   - With Node: set `SUPABASE_SERVICE_ROLE_KEY`, `SUPER_ADMIN_USERNAME` and `SUPER_ADMIN_PASSWORD` in `.env`, then run `npm run seed`.

   To add a demo shop, run `npm run seed -- --demo`, or in the SQL Editor: `select printflow_svc_create_demo_shop('demoshop', 'Shop1234', 'demoprint1');`. The demo shop signs in as `demoshop` / `Shop1234`, and its customer page is `/s/demoprint1`.
6. **Run:** `npm run dev` and open http://localhost:3000.

Other scripts: `npm run build` (typecheck + production build into `dist/`), `npm run preview`, `npm run lint`.

## Roles

| Role | Sign in at | What they can do |
| --- | --- | --- |
| **Super Admin** | `/login` | Create, edit, activate/deactivate and delete shops; generate and reset shop-owner credentials; platform stats and activity log |
| **Shop owner** | `/login` | Only their own shop: orders and files, order status, payment, prices, QR code, shop details, own password |
| **Customer** | — | Scan the shop QR (`/s/<token>`), upload files and track an order with its tracking code. No login. |

Shops created by the Super Admin get a temporary password that must be changed at first sign-in.

## Database

| Table | Holds |
| --- | --- |
| `printflow_users` | Logins: username, bcrypt password hash, role, shop, lockout counter |
| `printflow_sessions` | Signed-in sessions (SHA-256 hash of the token, expiry 12 h) |
| `printflow_shops` | Shops and their QR tokens |
| `printflow_price_rules`, `printflow_finishing_options` | Each shop's prices |
| `printflow_orders`, `printflow_order_files`, `printflow_order_events` | Orders, their files and status history |
| `printflow_activity_log` | Activity log |
| `printflow_storage_trash` | Deleted files waiting to be removed from Storage |

## How sign-in and data access work

1. `printflow_login(portal, username, password)` checks the bcrypt hash and returns a random session token. Only the token's hash is stored. After 5 wrong passwords the account is locked for 5 minutes.
2. The app stores the token in the browser and sends it as the `x-printflow-session` header with every database request (see `src/services/supabase.ts`).
3. Row Level Security reads that header, so each request sees only:
   - **Super Admin:** everything.
   - **Shop owner:** their own active shop.
   - **Customer, or no or invalid token:** nothing.
4. Clients can't read `printflow_users` or `printflow_sessions` at all. Every write goes through a `printflow_*` database function, which checks the session, validates input and writes the activity log.
5. Changing a password, an admin reset, or deactivating a shop ends the affected sessions immediately.
6. **Files:** customers can upload new files to `incoming/…` in the private bucket `printflow-files`, but can never read them. Storage RLS reads the same session header: shop owners can read only their own shop's files, and files queued for deletion are removed by the app (`cleanupStorage`).
7. `printflow_create_order` recalculates the price from the shop's own prices, so the browser's estimate is only a preview.

Without Supabase Realtime, dashboards refresh every 15 seconds and right after any change made in the same browser.

## QR codes

- **Generate:** Shop owner → **QR code** creates the QR image in the browser (`qrcode`), with print and PNG download.
- **Scan:** Home page → **Scan a shop QR code** decodes with the camera or from a photo/screenshot (`jsqr`), then opens the shop's upload page.
## Printing

Selected files are merged into one PDF in the browser with the customer's instructions applied: pages to print, pages per sheet (1/2/4), paper size, grey photos for black & white, and the copies.

- **Direct printing (recommended):** install the free [QZ Tray](https://qz.io/download/) on the shop computer, then **Settings → Direct printing** → turn on and choose the printer. **Print now** sends the job with the exact copies, paper size, colour and sides, without a print dialog. Saved per computer.
- **Browser print dialog:** works everywhere. Browsers do not let a website preset the dialog, so paper size and colour are chosen by hand (the print window lists what to choose); copies are already in the file.

## Project structure

```
src/
  services/            Data layer — the only code that talks to Supabase
    index.ts           Public entry: authService, adminService, shopService, publicService, onDbChange
    supabase.ts        Supabase client (adds the session header), RPC helpers, error mapping
    authService.ts     Sign in/out, current user, change password (own users table)
    adminService.ts    Super Admin: shops, owner accounts, stats, activity
    shopService.ts     Shop owner: profile, orders, files, prices, QR, print bundle
    publicService.ts   Customer: shop page, upload + create order, tracking
    session.ts         Current user and role checks
    realtime.ts        Screen refresh (after changes, other tabs, every 15 s)
    mappers.ts         Database row → UI type conversion
    validate.ts        Input validation
    crypto.ts          Password rules
    fileInspect.ts     File type checks and page counting
  shared/              Types and the price calculator
  lib/                 Router, auth context, useQuery hook, formatting
  components/          UI kit, layout, toasts, QR scanner
  pages/               public/, auth/, admin/, shop/
supabase/
  migrations/          Database schema, RLS policies, functions, storage bucket
  functions/printflow-files/  Edge Function: download links for shop owners, storage cleanup
scripts/seed.mjs       Creates the Super Admin (and optional demo shop) via the service-role key
docs/                  Original product spec
```

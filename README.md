# PrintFlow

QR-based file sharing for print shops. A customer scans a shop's QR code, uploads documents from their phone (no account), and the shop owner downloads, prints and tracks the order from their dashboard.

**Backend: Supabase database + Storage.** PrintFlow keeps its own users and sessions in the database (`printflow_users`, `printflow_sessions`); Supabase Auth is **not** used. All tables, functions and the Storage bucket are prefixed `printflow`, so the app can share a Supabase project with other apps.

## Setup

Requires **Node.js 20.19+** and a Supabase project (free tier is fine).

1. **Install:** `npm install`
2. **Configure:** copy `.env.example` to `.env`. Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from **Dashboard → Project Settings → API**.
3. **Create the database:** in **Dashboard → SQL Editor**, paste the contents of `supabase/migrations/20261113000000_printflow_init.sql` and run it.
4. **Deploy the file function:** run `npx supabase login`, then `npx supabase functions deploy printflow-files --no-verify-jwt --project-ref <your-ref>`. Or in the Dashboard: **Edge Functions → Deploy a new function**, name it `printflow-files`, paste `supabase/functions/printflow-files/index.ts`, and turn **Verify JWT** off. Shop owners need this function to open and print uploaded files.
5. **Create the Super Admin.** Pick one:
   - In the SQL Editor: `select printflow_svc_create_super_admin('superadmin', 'YourPassword123');`
   - With Node: set `SUPABASE_SERVICE_ROLE_KEY`, `SUPER_ADMIN_USERNAME` and `SUPER_ADMIN_PASSWORD` in `.env`, then run `npm run seed`.

   To add a demo shop, run `npm run seed -- --demo`, or in the SQL Editor: `select printflow_svc_create_demo_shop('demoshop', 'Shop1234', 'demoprint1');`. The demo shop signs in as `demoshop` / `Shop1234`, and its customer page is `/s/demoprint1`.
6. **Run:** `npm run dev` and open http://localhost:3000.

Other scripts: `npm run build` (typecheck + production build into `dist/`), `npm run preview`, `npm run lint`.

## Roles

| Role | Sign in at | What they can do |
| --- | --- | --- |
| **Super Admin** | `/admin/login` | Create, edit, activate/deactivate and delete shops; generate and reset shop-owner credentials; platform stats and activity log |
| **Shop owner** | `/shop/login` | Only their own shop: orders and files, order status, payment, prices, QR code, shop details, own password |
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
6. **Files:** customers can upload new files to `incoming/…` in the private bucket `printflow-files`, but can never read them. Shop owners open files through short-lived links from the `printflow-files` Edge Function, which asks the database (with the owner's token) which files they may open. Deleted files and abandoned uploads are removed by the same function.
7. `printflow_create_order` recalculates the price from the shop's own prices, so the browser's estimate is only a preview.

Without Supabase Realtime, dashboards refresh every 15 seconds and right after any change made in the same browser.

## QR codes

- **Generate:** Shop owner → **QR code** creates the QR image in the browser (`qrcode`), with print and PNG download.
- **Scan:** Home page → **Scan a shop QR code** decodes with the camera or from a photo/screenshot (`jsqr`), then opens the shop's upload page.
- Printing uses the browser's print dialog (selected files are merged into one PDF in the browser).

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

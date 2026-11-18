# Token Dashboard

Đo token Claude Code đã dùng — theo phiên, theo task, theo chu kỳ tuần / 5 giờ — và xem trực tiếp trên mọi thiết bị.

```
Claude Code trên PC (plugin token-meter) ──▶ máy chủ (Google Apps Script) ──▶ app Token Dashboard (điện thoại, PC, máy tính bảng)
```

- **App:** <https://phuchieu98.github.io/token-dashboard/> — cài được như ứng dụng (PWA), tự làm mới mỗi 5 giây, tự báo khi có bản mới.
- **Plugin cho Claude Code:** `token-meter` (thư mục `claude-mod/token-meter/`) — đo token và gửi lên máy chủ sau mỗi task.

## 1. Cài plugin trên PC chạy Claude Code

Trong ứng dụng Claude (tab Code): bấm **+** cạnh ô nhập → **Plugins** → **Add marketplace** → nhập `phuchieu98/token-dashboard` → **Add plugin** ở mục `token-meter`.

Hoặc trong một phiên Claude Code ở terminal:

```
/plugin install token-meter --marketplace phuchieu98/token-dashboard
```

Trả lời `y` khi được hỏi thêm marketplace, rồi chọn phạm vi **user** để plugin chạy trong mọi phiên.

Từ dòng lệnh (shell):

```
claude plugin install token-meter --marketplace phuchieu98/token-dashboard
```

## 2. Liên kết tài khoản Claude với app

1. Mở app, đăng nhập bằng tài khoản + mật khẩu hoặc tài khoản Google.
2. Menu **T** → **Liên kết tài khoản** → **+ Liên kết thêm tài khoản Claude** → sao chép lệnh hiện ra.
3. Dán vào Claude Code: `/token-meter link ABCD-EFGH [tên tuỳ chọn]` (mã có hạn 10 phút).

Làm lại bước 2–3 cho mỗi tài khoản / máy Claude Code khác. Trên điện thoại chỉ cần cài app và đăng nhập cùng tài khoản.

## Lệnh của plugin

| Lệnh | Việc |
| --- | --- |
| `/token-meter link <mã> [tên]` | Liên kết Claude Code này với tài khoản trong app |
| `/token-meter unlink` | Ngừng gửi số liệu từ máy này |
| `/token-meter open` | Mở tab Token cạnh khung chat |
| `/token-meter sync` | Gửi số liệu ngay |
| `/token-meter budget <số>` | Đặt ngân sách token (0 để tắt) |
| `/token-meter private on\|off` | Bật: chỉ gửi số liệu, không gửi nội dung task |
| `/token-meter clear-history` | Xoá danh sách task trên máy này |

Plugin chỉ gửi số liệu token, tên skill/tool và (trừ khi bật `private`) 70 ký tự đầu của mỗi yêu cầu. Không gửi mã nguồn hay nội dung trả lời.

## Mã nguồn

- `index.html`, `sw.js`, `manifest.webmanifest`, `version.json` — app (PWA) chạy trên GitHub Pages.
- `claude-mod/token-meter/` — plugin cho Claude Code; `.claude-plugin/marketplace.json` liệt kê nó.

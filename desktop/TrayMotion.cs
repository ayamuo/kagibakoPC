using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Kagibako;

/// <summary>
/// タスクトレイへしまう・戻すときの動き。
/// Windows の標準の最小化はタスクバーのボタンへ縮むため、トレイにしまうときは、
/// 窓の見た目を写した板を時計の横（通知領域）へ縮めながら薄くする。
/// 戻すときは中身を写さず（ロック後に前の画面が一瞬見えないように）、無地の板をトレイから広げてから窓を出す。
/// Windows の設定でアニメーションを切っているときは、動きなしで隠す・出す。
/// </summary>
internal static class TrayMotion
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string cls, string? title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string? title);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] private static extern bool SystemParametersInfo(uint action, uint param, out bool value, uint winIni);
    private const uint SPI_GETCLIENTAREAANIMATION = 0x1042;
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int L, T, R, B; }

    private const int ShrinkMs = 220;
    private const int GrowMs = 180;

    /// <summary>Windows の「アニメーションを表示する」がオンか</summary>
    public static bool Enabled
    {
        get
        {
            try { return !SystemParametersInfo(SPI_GETCLIENTAREAANIMATION, 0, out var on, 0) || on; }
            catch { return true; }
        }
    }

    /// <summary>時計の横（通知領域）のだいたいの位置（画面の座標）</summary>
    public static Rectangle TrayArea()
    {
        var bar = FindWindow("Shell_TrayWnd", null);
        if (bar != IntPtr.Zero)
        {
            var notify = FindWindowEx(bar, IntPtr.Zero, "TrayNotifyWnd", null);
            if (notify != IntPtr.Zero && GetWindowRect(notify, out var n) && n.R > n.L && n.B > n.T)
                return Rectangle.FromLTRB(n.L, n.T, n.R, n.B);
            if (GetWindowRect(bar, out var t) && t.R > t.L && t.B > t.T)
            {
                var tb = Rectangle.FromLTRB(t.L, t.T, t.R, t.B);
                // 横長のタスクバー（下・上）なら右端、縦長（左・右）なら下端
                return tb.Width >= tb.Height
                    ? new Rectangle(tb.Right - tb.Height * 3, tb.Top, tb.Height * 3, tb.Height)
                    : new Rectangle(tb.Left, tb.Bottom - tb.Width, tb.Width, tb.Width);
            }
        }
        var s = Screen.PrimaryScreen?.Bounds ?? new Rectangle(0, 0, 1280, 720);
        return new Rectangle(s.Right - 160, s.Bottom - 48, 160, 48);
    }

    /// <summary>窓をトレイへしまう：見た目を写した板が時計の横へ縮みながら薄くなる。hide は本物の窓を隠す処理</summary>
    public static void ShrinkToTray(Form form, Action hide)
    {
        var start = form.Bounds;
        if (!Enabled || start.Width < 40 || start.Height < 40) { hide(); return; }
        Bitmap? shot = null;
        try
        {
            shot = new Bitmap(start.Width, start.Height);
            using var g = Graphics.FromImage(shot);
            g.CopyFromScreen(start.Location, Point.Empty, start.Size);
        }
        catch
        {
            shot?.Dispose();
            hide();
            return;
        }
        var ghost = new GhostForm { Bounds = start, BackgroundImage = shot, BackgroundImageLayout = ImageLayout.Stretch };
        ghost.Show();
        ghost.Bounds = start;
        hide();
        var target = Center(TrayArea());
        Animate(ShrinkMs, t =>
        {
            var e = t * t; // だんだん速く（吸い込まれるように）
            ghost.Bounds = Lerp(start, new Rectangle(target.X - 8, target.Y - 8, 16, 16), e);
            ghost.Opacity = 1 - 0.75 * e;
        }, () => { ghost.Close(); ghost.Dispose(); shot.Dispose(); });
    }

    /// <summary>トレイから戻す：無地の板が時計の横から窓の大きさまで広がってから、本物の窓を出す</summary>
    public static void GrowFromTray(Form form, Action show)
    {
        var end = form.Bounds;
        // 最小化したまま隠れていた場合など、窓の位置が画面の外なら動きなしで出す
        var onScreen = Screen.AllScreens.Any((sc) => sc.Bounds.IntersectsWith(end));
        if (!Enabled || !onScreen || end.Width < 40 || end.Height < 40) { show(); return; }
        var from = Center(TrayArea());
        var ghost = new GhostForm { BackColor = Color.FromArgb(20, 35, 58), Bounds = new Rectangle(from.X - 8, from.Y - 8, 16, 16), Opacity = 0.35 };
        ghost.Paint += (_, e) =>
        {
            var icon = form.Icon;
            if (icon is null || ghost.Width < 64 || ghost.Height < 64) return;
            var size = Math.Min(64, Math.Min(ghost.Width, ghost.Height) / 3);
            e.Graphics.DrawIcon(new Icon(icon, size, size), new Rectangle((ghost.Width - size) / 2, (ghost.Height - size) / 2, size, size));
        };
        ghost.Show();
        Animate(GrowMs, t =>
        {
            var e = 1 - (1 - t) * (1 - t); // だんだんゆっくり（ふわっと止まる）
            ghost.Bounds = Lerp(new Rectangle(from.X - 8, from.Y - 8, 16, 16), end, e);
            ghost.Opacity = 0.35 + 0.65 * e;
            ghost.Invalidate();
        }, () =>
        {
            show();
            // 本物の窓が描き終わるまで、少しだけ板を残してちらつきを防ぐ
            var t2 = new System.Windows.Forms.Timer { Interval = 60 };
            t2.Tick += (_, _) => { t2.Stop(); t2.Dispose(); ghost.Close(); ghost.Dispose(); };
            t2.Start();
        });
    }

    private static Point Center(Rectangle r) => new(r.Left + r.Width / 2, r.Top + r.Height / 2);

    private static Rectangle Lerp(Rectangle a, Rectangle b, double t) => new(
        (int)Math.Round(a.Left + (b.Left - a.Left) * t), (int)Math.Round(a.Top + (b.Top - a.Top) * t),
        Math.Max(1, (int)Math.Round(a.Width + (b.Width - a.Width) * t)), Math.Max(1, (int)Math.Round(a.Height + (b.Height - a.Height) * t)));

    private static void Animate(int ms, Action<double> step, Action done)
    {
        var sw = Stopwatch.StartNew();
        var timer = new System.Windows.Forms.Timer { Interval = 15 };
        timer.Tick += (_, _) =>
        {
            var t = Math.Min(1.0, sw.ElapsedMilliseconds / (double)ms);
            try { step(t); } catch { t = 1; }
            if (t < 1) return;
            timer.Stop();
            timer.Dispose();
            done();
        };
        step(0);
        timer.Start();
    }

    /// <summary>動きのための板：前面に出るが、操作を受け付けず、作業中の窓から入力を奪わない</summary>
    private sealed class GhostForm : Form
    {
        public GhostForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            DoubleBuffered = true;
        }

        protected override bool ShowWithoutActivation => true;

        protected override CreateParams CreateParams
        {
            get
            {
                const int WS_EX_TOOLWINDOW = 0x80, WS_EX_TRANSPARENT = 0x20, WS_EX_NOACTIVATE = 0x08000000;
                var cp = base.CreateParams;
                cp.ExStyle |= WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;
                return cp;
            }
        }
    }
}

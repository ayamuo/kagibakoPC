# Generate application assets directly from the approved v9 PNG, not from resized derivatives.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$source = [Drawing.Bitmap]::new((Join-Path $PSScriptRoot 'assets/kagibako-master.png'))
$background = $source.GetPixel(0, 0)
$res = Join-Path $root 'android/app/src/main/res'
$icons = Join-Path $root 'app/icons'

function Render-Png([int]$size, [double]$scale, [string]$target, [string]$mask = '') {
    $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [Drawing.Graphics]::FromImage($bitmap)
    $shape = $null
    try {
        $g.Clear([Drawing.Color]::Transparent)
        $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        if ($mask -eq 'round') {
            $shape = [Drawing.Drawing2D.GraphicsPath]::new()
            $shape.AddEllipse(0, 0, $size, $size)
            $g.SetClip($shape)
        } elseif ($mask -eq 'rounded') {
            $shape = [Drawing.Drawing2D.GraphicsPath]::new()
            $d = [single]($size * .25)
            $shape.AddArc(0, 0, $d, $d, 180, 90)
            $shape.AddArc($size-$d, 0, $d, $d, 270, 90)
            $shape.AddArc($size-$d, $size-$d, $d, $d, 0, 90)
            $shape.AddArc(0, $size-$d, $d, $d, 90, 90)
            $shape.CloseFigure()
            $g.SetClip($shape)
        }
        $brush = [Drawing.SolidBrush]::new($background)
        try { $g.FillRectangle($brush, 0, 0, $size, $size) } finally { $brush.Dispose() }
        $edge = [single]($size * $scale)
        $offset = [single](($size - $edge) / 2)
        $dest = [Drawing.RectangleF]::new($offset, $offset, $edge, $edge)
        $g.DrawImage($source, $dest, [Drawing.RectangleF]::new(0, 0, $source.Width, $source.Height), [Drawing.GraphicsUnit]::Pixel)
        $parent = Split-Path $target -Parent
        [IO.Directory]::CreateDirectory($parent) | Out-Null
        $bitmap.Save($target, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        if ($shape) { $shape.Dispose() }
        $g.Dispose()
        $bitmap.Dispose()
    }
}

try {
    foreach ($size in @(32, 180, 192, 512)) { Render-Png $size 1.2 (Join-Path $icons "icon-$size.png") }
    # PWA maskable: keep artwork within the central 80%-diameter safe circle.
    Render-Png 512 1.0 (Join-Path $icons 'icon-maskable-512.png')

    $sizes = @(16, 24, 32, 48, 64, 128, 256)
    $pngs = @()
    foreach ($size in $sizes) {
        $tmp = Join-Path $root "desktop/obj/icon-assets/$size.png"
        Render-Png $size 1.2 $tmp 'rounded'
        $pngs += ,([IO.File]::ReadAllBytes($tmp))
    }
    $stream = [IO.File]::Create((Join-Path $root 'desktop/app.ico'))
    $writer = [IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Length)
        $offset = 6 + 16 * $sizes.Length
        for ($i = 0; $i -lt $sizes.Length; $i++) {
            $s = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
            $writer.Write([byte]$s); $writer.Write([byte]$s)
            $writer.Write([byte]0); $writer.Write([byte]0)
            $writer.Write([uint16]1); $writer.Write([uint16]32)
            $writer.Write([uint32]$pngs[$i].Length); $writer.Write([uint32]$offset)
            $offset += $pngs[$i].Length
        }
        foreach ($png in $pngs) { $writer.Write([byte[]]$png) }
    } finally { $writer.Dispose(); $stream.Dispose() }

    # Android版（別のリポジトリ）が同じフォルダにあるときだけ、そのアイコンも作る
    if (Test-Path $res) { foreach ($density in @(@('mdpi',48,108), @('hdpi',72,162), @('xhdpi',96,216), @('xxhdpi',144,324), @('xxxhdpi',192,432))) {
        $dir = Join-Path $res "mipmap-$($density[0])"
        Render-Png $density[1] 1.2 (Join-Path $dir 'ic_launcher.png')
        Render-Png $density[1] 1.2 (Join-Path $dir 'ic_launcher_round.png') 'round'
        # 108dp canvas, 72dp normal mask. 1.17x visible scale keeps the artwork inside radius 33dp.
        Render-Png $density[2] (1.17 * 72 / 108) (Join-Path $dir 'ic_launcher_foreground.png')
    } }
    Write-Output 'Generated Windows ICO and app icons (and Android icons when android/ exists).'
} finally { $source.Dispose() }

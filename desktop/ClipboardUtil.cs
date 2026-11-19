using System.IO;

namespace Kagibako;

/// <summary>Windows のクリップボード履歴（Win+V）・クラウド同期に残さない形でのコピー</summary>
internal static class ClipboardUtil
{
    public static void SetProtected(string text)
    {
        var data = new DataObject();
        data.SetData(DataFormats.UnicodeText, text);
        data.SetData("ExcludeClipboardContentFromMonitorProcessing", new MemoryStream(BitConverter.GetBytes(1)));
        data.SetData("CanIncludeInClipboardHistory", new MemoryStream(BitConverter.GetBytes(0)));
        data.SetData("CanUploadToCloudClipboard", new MemoryStream(BitConverter.GetBytes(0)));
        Clipboard.SetDataObject(data, true, 5, 100);
    }

    /// <summary>クリップボードがまだ指定の内容なら消す（その後に別のものをコピーしていれば消さない）</summary>
    public static void ClearIf(string text)
    {
        try { if (Clipboard.ContainsText() && Clipboard.GetText() == text) Clipboard.Clear(); } catch { /* 他のアプリが使用中 */ }
    }
}

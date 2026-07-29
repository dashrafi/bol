# Bol text-injection helper. Persistent PowerShell 5.1 child driven by injector.js
# over a JSON-lines protocol on stdin/stdout:  {id,cmd,args} -> {id,ok,data?,error?}
# Commands: ping | active | paste | type | copysel
# NEVER writes pasted/copied text to any log — only structured responses go to stdout.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BolNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; public static int Size { get { return Marshal.SizeOf(typeof(INPUT)); } } }
  // The union MUST include MOUSEINPUT even though we only send keyboard events:
  // it is the largest member, and without it sizeof(INPUT) is 32 instead of 40,
  // which makes EVERY SendInput call fail with ERROR_INVALID_PARAMETER (87).
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr tok, int cls, out uint info, uint len, out uint ret);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();

  const uint KEYUP = 0x0002, UNICODE = 0x0004;
  const int VK_CONTROL = 0x11, VK_MENU = 0x12, VK_SHIFT = 0x10, VK_LWIN = 0x5B, VK_RWIN = 0x5C;

  static void One(ref INPUT[] a, int i, ushort vk, ushort scan, uint flags) {
    a[i].type = 1; a[i].U.ki.wVk = vk; a[i].U.ki.wScan = scan; a[i].U.ki.dwFlags = flags;
  }
  // Don't inject while the user still physically holds a modifier, or Ctrl+V becomes Win+Ctrl+V.
  public static void WaitModifiers(int timeoutMs) {
    int waited = 0;
    while (waited < timeoutMs) {
      bool down = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 || (GetAsyncKeyState(VK_MENU) & 0x8000) != 0
               || (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0 || (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0
               || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
      if (!down) return;
      System.Threading.Thread.Sleep(15); waited += 15;
    }
  }
  static uint Combo(ushort mod, ushort key) {
    INPUT[] a = new INPUT[4];
    One(ref a, 0, mod, 0, 0); One(ref a, 1, key, 0, 0);
    One(ref a, 2, key, 0, KEYUP); One(ref a, 3, mod, 0, KEYUP);
    return SendInput(4, a, INPUT.Size);
  }
  // All return the number of events injected — 0 means Windows rejected the call
  // (UIPI/blocked); callers MUST check and report failure instead of claiming ok.
  public static uint CtrlV() { WaitModifiers(1000); return Combo(0x11, 0x56); }
  public static uint CtrlC() { WaitModifiers(1000); return Combo(0x11, 0x43); }
  public static uint Enter() { WaitModifiers(1000); INPUT[] a = new INPUT[2]; One(ref a,0,0x0D,0,0); One(ref a,1,0x0D,0,KEYUP); return SendInput(2, a, INPUT.Size); }

  public static uint TypeString(string s) {
    WaitModifiers(1000);
    var list = new System.Collections.Generic.List<INPUT>(s.Length * 2);
    foreach (char c in s) {
      INPUT d = new INPUT(); d.type = 1; d.U.ki.wScan = c; d.U.ki.dwFlags = UNICODE;
      INPUT u = new INPUT(); u.type = 1; u.U.ki.wScan = c; u.U.ki.dwFlags = UNICODE | KEYUP;
      list.Add(d); list.Add(u);
    }
    INPUT[] arr = list.ToArray();
    if (arr.Length == 0) return 1;
    return SendInput((uint)arr.Length, arr, INPUT.Size);
  }

  public static uint ClipSeq() { return GetClipboardSequenceNumber(); }

  // Resolve the real foreground process id, unwrapping UWP's ApplicationFrameHost host window.
  static uint _hostPid; static uint _childPid;
  static bool ChildCb(IntPtr h, IntPtr lp) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid != _hostPid) { _childPid = pid; return false; }
    return true;
  }
  public static void ForegroundInfo(out string exe, out string title, out bool elevated) {
    exe = ""; title = ""; elevated = false;
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return;
    var sb = new StringBuilder(512); GetWindowText(h, sb, 512); title = sb.ToString();
    uint pid; GetWindowThreadProcessId(h, out pid);
    try {
      string name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
      if (name.Equals("ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) {
        _hostPid = pid; _childPid = 0;
        EnumChildWindows(h, ChildCb, IntPtr.Zero);
        if (_childPid != 0) { pid = _childPid; name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
      }
      exe = name.ToLowerInvariant();
    } catch { }
    // Best-effort elevation probe: if we can't open the token, the target is very likely elevated.
    IntPtr hp = OpenProcess(0x1000, false, pid); // QUERY_LIMITED_INFORMATION
    if (hp == IntPtr.Zero) { elevated = true; return; }
    try {
      IntPtr tok;
      if (OpenProcessToken(hp, 0x0008, out tok)) { // TOKEN_QUERY
        try { uint info, ret; if (GetTokenInformation(tok, 20, out info, 4, out ret)) elevated = info != 0; }
        finally { CloseHandle(tok); }
      }
    } finally { CloseHandle(hp); }
  }
}
'@ | Out-Null

function Get-ClipText {
  try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { return [System.Windows.Forms.Clipboard]::GetText() } } catch { }
  return $null
}
function Set-ClipText($t) {
  try { if ($null -eq $t -or $t -eq '') { [System.Windows.Forms.Clipboard]::Clear() } else { [System.Windows.Forms.Clipboard]::SetText($t) } } catch { }
}
function Send-Response($id, $ok, $data, $err) {
  $o = [ordered]@{ id = $id; ok = [bool]$ok }
  if ($null -ne $data) { $o.data = $data }
  if ($err) { $o.error = [string]$err }
  $json = ($o | ConvertTo-Json -Compress -Depth 6)
  [Console]::Out.WriteLine($json); [Console]::Out.Flush()
}

# Signal readiness so the Node side knows Add-Type finished compiling.
Send-Response 0 $true 'ready' $null

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }        # parent closed stdin -> exit
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    switch ($req.cmd) {
      'ping' { Send-Response $id $true 'pong' $null }
      'active' {
        $exe = ''; $title = ''; $elev = $false
        [BolNative]::ForegroundInfo([ref]$exe, [ref]$title, [ref]$elev)
        Send-Response $id $true ([ordered]@{ exe = $exe; title = $title; elevated = $elev }) $null
      }
      'paste' {
        $text = [string]$req.args.text
        $prev = Get-ClipText
        Set-ClipText $text
        Start-Sleep -Milliseconds 20
        $sent = [BolNative]::CtrlV()
        if ($sent -eq 0) {
          Set-ClipText $prev
          Send-Response $id $false $null 'SendInput rejected the paste keystroke (blocked by the system)'
        } else {
          if ($req.args.pressEnter) { Start-Sleep -Milliseconds 60; [void][BolNative]::Enter() }
          Start-Sleep -Milliseconds 350       # let the target read before we restore
          Set-ClipText $prev
          Send-Response $id $true 'ok' $null
        }
      }
      'type' {
        $sent = [BolNative]::TypeString([string]$req.args.text)
        if ($sent -eq 0) {
          Send-Response $id $false $null 'SendInput rejected the typed text (blocked by the system)'
        } else {
          if ($req.args.pressEnter) { Start-Sleep -Milliseconds 40; [void][BolNative]::Enter() }
          Send-Response $id $true 'ok' $null
        }
      }
      'copysel' {
        $prev = Get-ClipText
        $seq0 = [BolNative]::ClipSeq()
        [System.Windows.Forms.Clipboard]::Clear()
        $sent = [BolNative]::CtrlC()
        $got = ''
        if ($sent -ne 0) {
          $waited = 0
          while ($waited -lt 600) {
            Start-Sleep -Milliseconds 40; $waited += 40
            if ([BolNative]::ClipSeq() -ne $seq0) {
              $c = Get-ClipText
              if ($null -ne $c) { $got = $c; break }
            }
          }
        }
        Start-Sleep -Milliseconds 30
        Set-ClipText $prev
        Send-Response $id $true ([ordered]@{ text = $got }) $null
      }
      default { Send-Response $id $false $null ('unknown cmd: ' + [string]$req.cmd) }
    }
  } catch {
    Send-Response $id $false $null $_.Exception.Message
  }
}

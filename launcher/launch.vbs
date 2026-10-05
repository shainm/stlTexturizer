' Opens my BumpMesh (stlTexturizer) checkout as a desktop-style app.
' Starts the hidden local server (serve.py) on PORT if it isn't answering,
' then opens the page in its own Edge app window (default browser if no Edge).
' A file passed as the first argument (a double-clicked .bumpmesh) is handed
' to the page as ?open=<path>.
Option Explicit
Const PORT = 8765
Dim sh, fso, root, here, url, edge, i, target
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
url = "http://127.0.0.1:" & PORT & "/"

' The current server answers /api/token; an older one only serves files.
Function Probe(path)
  Dim http
  Probe = 0
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 500, 500, 1000, 1000
  http.Open "GET", url & path, False
  http.Send
  If Err.Number = 0 Then Probe = http.Status
  On Error GoTo 0
End Function

Sub StopOldServers()
  Dim wmi, p
  Set wmi = GetObject("winmgmts:\.\root\cimv2")
  For Each p In wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name='pythonw.exe' OR Name='python.exe'")
    If Not IsNull(p.CommandLine) Then
      If InStr(1, p.CommandLine, "serve.py", vbTextCompare) > 0 Or InStr(1, p.CommandLine, "http.server " & PORT, vbTextCompare) > 0 Then p.Terminate
    End If
  Next
End Sub

If Probe("api/token") <> 200 Then
  If Probe("index.html") = 200 Then StopOldServers : WScript.Sleep 500
  sh.Run "pythonw """ & fso.BuildPath(here, "serve.py") & """ " & PORT, 0, False
  For i = 1 To 40
    WScript.Sleep 250
    If Probe("api/token") = 200 Then Exit For
  Next
  If Probe("api/token") <> 200 Then
    MsgBox "Couldn't start the local web server for BumpMesh." & vbCrLf & _
      "Check that Python is installed (pythonw on PATH).", vbExclamation, "BumpMesh"
    WScript.Quit 1
  End If
End If

target = url
If WScript.Arguments.Count > 0 Then target = url & "?open=" & Escape(WScript.Arguments(0))

edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
If fso.FileExists(edge) Then
  sh.Run """" & edge & """ --app=" & target, 1, False
Else
  sh.Run target, 1, False
End If

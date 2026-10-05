' Opens my BumpMesh (stlTexturizer) checkout as a desktop-style app.
' Starts a hidden local web server on PORT if one isn't already answering,
' then opens the page in its own Edge app window (default browser if no Edge).
Option Explicit
Const PORT = 8765
Dim sh, fso, root, url, edge, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
url = "http://127.0.0.1:" & PORT & "/"

Function ServerUp()
  Dim http
  ServerUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 500, 500, 1000, 1000
  http.Open "GET", url & "index.html", False
  http.Send
  If Err.Number = 0 Then ServerUp = (http.Status = 200)
  On Error GoTo 0
End Function

If Not ServerUp() Then
  ' pythonw = no console window; serves this checkout only, on localhost only.
  sh.Run "pythonw """ & fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "serve.py") & """ " & PORT, 0, False
  For i = 1 To 40
    WScript.Sleep 250
    If ServerUp() Then Exit For
  Next
  If Not ServerUp() Then
    MsgBox "Couldn't start the local web server for BumpMesh." & vbCrLf & _
      "Check that Python is installed (pythonw on PATH).", vbExclamation, "BumpMesh"
    WScript.Quit 1
  End If
End If

edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
If fso.FileExists(edge) Then
  sh.Run """" & edge & """ --app=" & url, 1, False
Else
  sh.Run url, 1, False
End If

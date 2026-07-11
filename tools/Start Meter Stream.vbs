' Double-click to open the Wall Vibe live meter streamer (no console window).
' Launches the GUI using this folder's bundled Python venv (tkinter + hidapi).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
pyw = """" & here & "\.venv\Scripts\pythonw.exe"""
scr = """" & here & "\meter_gui.py"""
sh.CurrentDirectory = here
sh.Run pyw & " " & scr, 0, False

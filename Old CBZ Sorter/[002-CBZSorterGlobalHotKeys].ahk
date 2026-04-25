#NoEnv
#SingleInstance Force
SetTitleMatchMode, 2

CBZWindowTitle := "CBZ Sorter"

SendKeyToCBZ(key) {
    global CBZWindowTitle
    if WinExist(CBZWindowTitle) {
        WinActivate, %CBZWindowTitle%
        Sleep, 50
        SendInput, {%key%}
    } else {
        ToolTip, CBZ Sorter not running!
        SetTimer, RemoveToolTip, -1500
    }
}

SendCtrlKey(key) {
    global CBZWindowTitle
    if WinExist(CBZWindowTitle) {
        WinActivate, %CBZWindowTitle%
        Sleep, 50
        SendInput, ^{%key%}
    } else {
        ToolTip, CBZ Sorter not running!
        SetTimer, RemoveToolTip, -1500
    }
}

RemoveToolTip() {
    ToolTip
}

SoundBeep, 500, 100

; All single letter keys
$k::SendKeyToCBZ("k")
$p::SendKeyToCBZ("p")
$n::SendKeyToCBZ("n")
$b::SendKeyToCBZ("b")
$c::SendKeyToCBZ("c")
$q::SendKeyToCBZ("q")
$r::SendKeyToCBZ("r")
$t::SendKeyToCBZ("t")
$f::SendKeyToCBZ("f")
$i::SendKeyToCBZ("i")
$u::SendKeyToCBZ("u")

; Ctrl combinations
$^s::SendCtrlKey("s")
$^v::SendCtrlKey("v")
$^r::SendCtrlKey("r")     ; Ctrl+R → Refresh
$^F5::SendCtrlKey("r")    ; Ctrl+F5 → also send 'r'

$^+q::
    SoundBeep, 300, 200
    ExitApp
return

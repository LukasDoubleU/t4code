!include "StrFunc.nsh"
!ifdef BUILD_UNINSTALLER
  ${UnStrRep}
  !define T3StrRep '${UnStrRep}'
!else
  ${StrRep}
  !define T3StrRep '${StrRep}'
!endif

; Fork-only: T4 Code registers under its own product code (nsis.guid in
; build-desktop-artifact.ts). Builds before it used T3 Code's, which winget's
; T3Tools.T3Code matches.
!define T3CODE_PRODUCT_CODE "e9197887-efb3-55e0-985e-d6d3b5dd594a"
!define T3CODE_INSTALL_KEY "Software\${T3CODE_PRODUCT_CODE}"
!define T3CODE_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${T3CODE_PRODUCT_CODE}"

; Fork-only: the executable keeps T3 Code's product name, so name the app as
; its shortcuts and Apps entry do.
!macro customAppRunningMessages
  ${T3StrRep} $appRunningMessage $appRunningMessage "${PRODUCT_NAME}" "${SHORTCUT_NAME}"
  ${T3StrRep} $appClosingMessage $appClosingMessage "${PRODUCT_NAME}" "${SHORTCUT_NAME}"
  ${T3StrRep} $appCannotBeClosedMessage $appCannotBeClosedMessage "${PRODUCT_NAME}" "${SHORTCUT_NAME}"
!macroend

!ifndef BUILD_UNINSTALLER
  ; Fork-only: the first install under T4 Code's product code takes over the
  ; folder and shortcut settings of an install under T3 Code's, as an update
  ; would. The installer is per-user, so both live in HKCU.
  !macro preInit
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $1 HKCU "${T3CODE_INSTALL_KEY}" InstallLocation
    ${If} $0 == ""
    ${AndIf} $1 != ""
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation $1
      ReadRegStr $1 HKCU "${T3CODE_INSTALL_KEY}" KeepShortcuts
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" KeepShortcuts $1
      ReadRegStr $1 HKCU "${T3CODE_INSTALL_KEY}" ShortcutName
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" ShortcutName $1
    ${EndIf}
  !macroend
!endif

!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif

  ; Fork-only: once this folder is registered under T4 Code's product code,
  ; drop T3 Code's entries for it without running their uninstaller, whose
  ; files this install replaced. Entries for another folder stay.
  ReadRegStr $0 HKCU "${T3CODE_UNINSTALL_KEY}" UninstallString
  !insertmacro GetInQuotes $0 "$0"
  Push $0
  Call GetFileParent
  Pop $0
  ${If} $0 == $INSTDIR
    DeleteRegKey HKCU "${T3CODE_UNINSTALL_KEY}"
  ${EndIf}
  ReadRegStr $0 HKCU "${T3CODE_INSTALL_KEY}" InstallLocation
  ${If} $0 == $INSTDIR
    DeleteRegKey HKCU "${T3CODE_INSTALL_KEY}"
  ${EndIf}
!macroend

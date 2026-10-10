/*
 * The shell side of the file manager: one operation per run, inside a helper container (see
 * helper.ts). $1 is the root the files are under (/host for a server, /proc/1/root for a
 * container), $2 the operation, the rest its arguments: paths as seen inside that root.
 *
 * Paths are resolved like a chroot would: a symbolic link to /etc/passwd inside a container is
 * the container's /etc/passwd, and ".." stops at the root. The helper of a container sees only
 * that container, so even a link swapped in the middle of an operation leads nowhere else.
 *
 * Exit codes: 2 not found, 3 permission denied, 4 link loop, 5 not allowed or invalid, 6 already exists,
 * 7 changed since read. The message is on standard error.
 *
 * Written with $[name] where the shell has ${name}: the template would read "${" as its own.
 */
export const FILES_SCRIPT = String.raw`
R=$1; op=$2; shift 2
die() { printf '%s\n' "$2" >&2; exit "$1"; }
resolve() {
  rest=$[1#/]; out=""; hops=0; keep=$2
  while [ -n "$rest" ]; do
    case $rest in */*) comp=$[rest%%/*]; rest=$[rest#*/] ;; *) comp=$rest; rest="" ;; esac
    case $comp in ""|.) continue ;; ..) out=$[out%/*]; continue ;; esac
    if [ -L "$R$out/$comp" ] && { [ -n "$rest" ] || [ -z "$keep" ]; }; then
      hops=$((hops + 1)); [ $hops -gt 40 ] && die 4 "Too many levels of symbolic links"
      t=$(readlink "$R$out/$comp")
      case $t in /*) out=""; rest="$[t#/]$[rest:+/$rest]" ;; *) rest="$t$[rest:+/$rest]" ;; esac
    else
      out="$out/$comp"
    fi
  done
  printf '%s' "$[out:-/]"
}
case $op in
list)
  p=$(resolve "$1") || exit; d="$R$p"
  [ -e "$d" ] || die 2 "No such folder"
  [ -d "$d" ] || die 5 "Not a folder"
  [ -r "$d" ] && [ -x "$d" ] || die 3 "Permission denied"
  printf '%s\0' "$p"
  pw=$(resolve /etc/passwd); gr=$(resolve /etc/group)
  cut -d: -f1,3 "$R$pw" 2>/dev/null | tr '\n' ' '; printf '\0'
  cut -d: -f1,3 "$R$gr" 2>/dev/null | tr '\n' ' '; printf '\0'
  find "$d/" -mindepth 1 -maxdepth 1 -exec stat -c '%f/%s/%Y/%u/%g/%n' -- {} + 2>/dev/null; printf '\0'
  for f in "$d"/* "$d"/.[!.]* "$d"/..?*; do
    [ -L "$f" ] || continue
    t=$(readlink "$f"); k=x
    case $t in /*) q=$t ;; *) q="$p/$t" ;; esac
    if q=$(resolve "$q" 2>/dev/null); then
      if [ -d "$R$q" ]; then k=d; elif [ -e "$R$q" ]; then k=f; fi
    fi
    printf '%s\0%s\0%s\0' "$[f##*/]" "$t" "$k"
  done ;;
stat)
  p=$(resolve "$1") || exit
  [ -e "$R$p" ] || die 2 "No such file or folder"
  printf '%s\0' "$p"; stat -c '%f/%s/%Y' -- "$R$p" ;;
read)
  p=$(resolve "$1") || exit; f="$R$p"
  [ -e "$f" ] || die 2 "No such file"
  [ -f "$f" ] || die 5 "Not a file"
  [ -r "$f" ] || die 3 "Permission denied"
  exec cat -- "$f" ;;
hash)
  p=$(resolve "$1") || exit
  [ -f "$R$p" ] || die 2 "No such file"
  sha256sum < "$R$p" | cut -d' ' -f1 ;;
write)
  # $2: the sha256 the file must still have, "new" when it must not exist yet, "-" to replace.
  p=$(resolve "$1") || exit; f="$R$p"; dir=$[f%/*]
  [ "$p" = / ] && die 5 "Not a file"
  [ -d "$dir/" ] || die 2 "The folder does not exist"
  [ -d "$f" ] && die 5 "A folder has that name"
  if [ "$2" = new ] && { [ -e "$f" ] || [ -L "$f" ]; }; then die 6 "A file with that name already exists"; fi
  if [ "$2" != - ] && [ "$2" != new ]; then
    cur=""; [ -f "$f" ] && cur=$(sha256sum < "$f" | cut -d' ' -f1)
    [ "$cur" = "$2" ] || die 7 "The file changed since you opened it"
  fi
  tmp="$dir/.$[f##*/].serve-$$"
  if ! cat > "$tmp"; then rm -f -- "$tmp"; die 1 "Could not write the file (is the disk full?)"; fi
  if [ -e "$f" ]; then
    chmod "$(stat -c %a -- "$f")" "$tmp"; chown "$(stat -c %u:%g -- "$f")" "$tmp"
  else
    chmod 644 "$tmp"; chown "$(stat -c %u:%g -- "$dir/")" "$tmp"
  fi
  mv -f -- "$tmp" "$f" || { rm -f -- "$tmp"; die 1 "Could not save the file"; }
  printf '%s' "$p" ;;
mkdir)
  p=$(resolve "$1" nofollow) || exit; f="$R$p"; dir=$[f%/*]
  { [ -e "$f" ] || [ -L "$f" ]; } && die 6 "Something with that name already exists"
  [ -d "$dir/" ] || die 2 "The folder does not exist"
  mkdir -- "$f" || die 1 "Could not create the folder"
  chown "$(stat -c %u:%g -- "$dir/")" "$f"
  printf '%s' "$p" ;;
move)
  a=$(resolve "$1" nofollow) || exit; b=$(resolve "$2" nofollow) || exit
  [ "$a" = / ] && die 5 "The top folder cannot be moved"
  { [ -e "$R$a" ] || [ -L "$R$a" ]; } || die 2 "No such file or folder"
  { [ -e "$R$b" ] || [ -L "$R$b" ]; } && die 6 "Something with that name already exists"
  case "$b/" in "$a"/*) die 5 "A folder cannot be moved into itself" ;; esac
  mv -- "$R$a" "$R$b" || die 1 "Could not move it"
  printf '%s' "$b" ;;
delete)
  p=$(resolve "$1" nofollow) || exit
  [ "$p" = / ] && die 5 "The top folder cannot be deleted"
  { [ -e "$R$p" ] || [ -L "$R$p" ]; } || die 2 "No such file or folder"
  rm -rf -- "$R$p" || die 1 "Could not delete everything" ;;
extract)
  # A .tar.gz on standard input, unpacked into the folder $1. $2 "replace" merges into what is
  # there (files overwritten); otherwise an entry that exists already stops it before anything is
  # written. Unpacked aside first, so a broken archive leaves nothing behind.
  p=$(resolve "$1") || exit; d="$R$p"
  [ -d "$d/" ] || die 2 "The folder does not exist"
  t="$d/.serve-unpack-$$"
  mkdir -- "$t" || die 1 "Could not write in the folder"
  trap 'rm -rf -- "$t"' EXIT
  tar -xzof - -C "$t" || die 5 "The archive could not be unpacked"
  chown -Rh "$(stat -c %u:%g -- "$d/")" "$t"
  if [ "$2" != replace ]; then
    for f in "$t"/* "$t"/.[!.]* "$t"/..?*; do
      { [ -e "$f" ] || [ -L "$f" ]; } || continue
      { [ -e "$d/$[f##*/]" ] || [ -L "$d/$[f##*/]" ]; } && die 6 "$p/$[f##*/] already exists"
    done
    for f in "$t"/* "$t"/.[!.]* "$t"/..?*; do
      { [ -e "$f" ] || [ -L "$f" ]; } || continue
      mv -- "$f" "$d/" || die 1 "Could not move the files into place"
    done
  else
    cp -a -- "$t/." "$d/" || die 1 "Could not copy the files into place"
  fi
  printf '%s' "$p" ;;
archive)
  # A folder, or with names after it, those entries of the folder (several picked at once).
  p=$(resolve "$1") || exit; shift
  [ -d "$R$p" ] || die 2 "No such folder"
  if [ $# -gt 0 ]; then
    for n; do
      case $n in */*|.|..|"") die 5 "Not a name: $n" ;; esac
      { [ -e "$R$p/$n" ] || [ -L "$R$p/$n" ]; } || die 2 "No such file or folder: $n"
    done
    cd "$R$p/" || die 3 "Permission denied"
    # Each name as ./name, so one starting with "-" is not read as an option.
    for n; do set -- "$@" "./$n"; shift; done
    exec tar -czf - "$@"
  fi
  if [ "$p" = / ]; then exec tar -C "$R/" -czf - .; fi
  exec tar -C "$R$[p%/*]/" -czf - "$[p##*/]" ;;
*) die 1 "Unknown operation" ;;
esac
`.replace(/\$\[([^\]]*)\]/g, "$${$1}");

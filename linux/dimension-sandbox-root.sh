#!/bin/sh
# Root supervisor for one internal WSL workload. User/model arguments are never
# evaluated by this shell: the native caller passes an argv vector after four
# validated resource values. The child enters the cgroup before executing bwrap.
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
IFS=' 	
'
set -u
if [ "$#" -lt 6 ]; then exit 64; fi
name=$1
memory=$2
cpu_quota=$3
cpu_period=$4
pids=$5
shift 5
if [ "${#name}" -gt 80 ]; then exit 64; fi
case $name in
    dimension-[0-9]*)
        case $name in *[!a-z0-9-]*) exit 64;; esac
        ;;
    *) exit 64;;
esac
case $memory in *[!0-9]*|'') exit 64;; esac
case $cpu_quota in *[!0-9]*|'') exit 64;; esac
case $cpu_period in *[!0-9]*|'') exit 64;; esac
case $pids in *[!0-9]*|'') exit 64;; esac
if [ "$memory" -lt 67108864 ] || [ "$memory" -gt 4294967296 ] ||
   [ "$cpu_quota" -lt 10000 ] || [ "$cpu_quota" -gt 1000000 ] ||
   [ "$cpu_period" -ne 100000 ] || [ "$pids" -lt 16 ] || [ "$pids" -gt 1024 ]; then exit 64; fi
base=/sys/fs/cgroup/$name
child=

reap_cgroup() {
    if [ ! -d "$base" ]; then return 0; fi
    if [ -f "$base/cgroup.kill" ]; then
        echo 1 > "$base/cgroup.kill" 2>/dev/null || true
    elif [ -f "$base/cgroup.procs" ]; then
        while IFS= read -r pid; do
            [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null || true
        done < "$base/cgroup.procs"
    fi
    i=0
    while [ "$i" -lt 40 ]; do
        if rmdir "$base" 2>/dev/null; then return 0; fi
        sleep 0.05 2>/dev/null || sleep 1
        i=$((i + 1))
    done
    rmdir "$base" 2>/dev/null
}

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
        kill -TERM "$child" 2>/dev/null
        sleep 0.2 2>/dev/null || sleep 1
        kill -KILL "$child" 2>/dev/null
    fi
    reap_cgroup || status=125
    exit "$status"
}
trap cleanup EXIT HUP INT TERM
if [ -e "$base" ]; then exit 73; fi
mkdir "$base" || exit 1
echo "$memory" > "$base/memory.max" || exit 1
if [ -f "$base/memory.swap.max" ]; then echo 0 > "$base/memory.swap.max" || exit 1; fi
echo "$cpu_quota $cpu_period" > "$base/cpu.max" || exit 1
echo "$pids" > "$base/pids.max" || exit 1
# Non-interactive shells redirect asynchronous stdin from /dev/null. Preserve
# the caller's request stream explicitly for the NDJSON execution helper.
exec 3<&0
/bin/sh -c 'echo "$$" > "$1/cgroup.procs" && shift && exec "$@"' dimension-worker "$base" "$@" <&3 &
child=$!
exec 3<&-
wait "$child"
status=$?
child=
reap_cgroup || exit 125
trap - EXIT HUP INT TERM
exit "$status"

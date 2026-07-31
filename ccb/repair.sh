#!/bin/bash
# ccb-repair: 清理 ccbd 损坏状态并重启 ccb
# 用法: .ccb/repair.sh [项目目录]
#   不带参数: 在当前目录的 .ccb 下操作
#   带参数:   在指定目录的 .ccb 下操作

set -e

PROJECT_DIR="${1:-.}"
CCB_DIR="$PROJECT_DIR/.ccb"

if [ ! -d "$CCB_DIR" ]; then
    echo "错误: $CCB_DIR 不存在"
    exit 1
fi

CCBD_DIR="$CCB_DIR/ccbd"

echo "==> 停止 ccb..."
ccb stop 2>/dev/null || true
sleep 1

echo "==> 清理残留 ccbd 进程..."
pkill -f "ccbd.*$(basename "$(realpath "$PROJECT_DIR")")" 2>/dev/null || true
sleep 1

echo "==> 清理损坏状态文件..."
rm -f "$CCBD_DIR"/keeper.* \
      "$CCBD_DIR"/lease.* \
      "$CCBD_DIR"/lifecycle.* \
      "$CCBD_DIR"/lifecycle.jsonl \
      "$CCBD_DIR"/state.* \
      "$CCBD_DIR"/startup.* \
      "$CCBD_DIR"/restore* \
      "$CCBD_DIR"/runtime-accelerator.* \
      "$CCBD_DIR"/*.sock \
      "$CCBD_DIR"/*.log 2>/dev/null
rm -rf "$CCB_DIR/runtime-accelerator" 2>/dev/null

echo "==> 重启 ccb..."
cd "$PROJECT_DIR"
ccb

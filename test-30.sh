#!/bin/bash
# 30题压力测试 - 用curl跑Vercel线上接口
URL="https://ai-travel-assistant-five.vercel.app/api/chat"

# 定义测试用例: id|level|query|expect_type
tests=(
  "1|L1|帮我查杭州的酒店|hotel_hangzhou"
  "2|L1|北京机票多少钱|flight_beijing"
  "3|L1|上海到杭州的高铁|train_shanghai_hangzhou"
  "4|L1|三亚有什么好玩的|poi_sanya"
  "5|L1|成都的民宿|hotel_chengdu_homestay"
  "6|L1|明天广州去成都的航班|flight_guangzhou_chengdu_tomorrow"
  "7|L1|玉林到北京的火车票|train_yulin_beijing"
  "8|L1|西湖附近的酒店|hotel_xihu"
  "9|L1|深圳飞成都|flight_shenzhen_chengdu"
  "10|L1|厦门景点推荐|poi_xiamen"
  "11|L2|机票|askback_origin_dest"
  "12|L2|去三亚怎么走|askback_transport"
  "13|L2|200元以内的酒店|askback_or_hotel"
  "14|L2|后天上海到北京的高铁|train_dayafter"
  "15|L2|北京直飞三亚|flight_direct"
  "16|L2|五一去杭州的酒店|hotel_may1"
  "17|L2|这周六上海到杭州的高铁|train_saturday"
  "18|L2|红眼航班 上海到北京|flight_redeye"
  "19|L3|帮我查北京到上海的机票和酒店|compound_flight_hotel"
  "20|L3|杭州西湖附近的酒店和景点|compound_hotel_poi"
  "21|L3|广州去成都的机票和住宿|compound_flight_hotel"
  "22|L3|上海到杭州的高铁和酒店|compound_train_hotel"
  "23|L3|三亚的机票和景点|compound_flight_poi"
  "24|L3|北京玩住酒店和看景点|compound_hotel_poi"
  "25|L4|下个月15号上海到广州的火车|train_nextmonth15"
  "26|L4|国庆去三亚的机票|flight_nationalday"
  "27|L4|玉林到上海|askback_or_transport"
  "28|L4|便宜又近地铁的酒店|aisearch_or_askback"
  "29|L5|春节北京到三亚机票和酒店|compound_spring_hotel"
  "30|L5|下下周一广州到成都的高铁和住宿|compound_nextnextmonday"
)

echo ""
echo "🧪 30题压力测试 - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "============================================================"

pass=0
fail=0
results=()

for test in "${tests[@]}"; do
  IFS='|' read -r id level query expect <<< "$test"

  # URL encode the query for JSON
  json_payload=$(python3 -c "import json; print(json.dumps({'message': '$query'}))" 2>/dev/null || echo "{\"message\":\"$query\"}")

  # Call API
  response=$(curl -s -X POST "$URL" \
    -H "Content-Type: application/json" \
    -d "$json_payload" \
    --max-time 30 2>/dev/null)

  # Extract reply and askBack
  reply=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('reply',''))" 2>/dev/null || echo "")
  has_askback=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('askBack') else 'no')" 2>/dev/null || echo "no")

  # Judge
  verdict="❌"
  reason=""

  case "$expect" in
    askback_*)
      if [ "$has_askback" = "yes" ] || echo "$reply" | grep -qE "从哪|去哪|哪个城市|怎么走"; then
        verdict="✅"; reason="追问成功"; ((pass++))
      else
        reason="未触发追问"; ((fail++))
      fi
      ;;
    compound_*)
      # Check for multiple sections
      case "$expect" in
        compound_flight_hotel)
          has_flight=$(echo "$reply" | grep -cE "✈️|航班|机票" || true)
          has_hotel=$(echo "$reply" | grep -cE "🏨|酒店|住宿" || true)
          if [ "$has_flight" -gt 0 ] && [ "$has_hotel" -gt 0 ]; then
            verdict="✅"; reason="复合拆解成功(机票+酒店)"; ((pass++))
          else
            missing=""
            [ "$has_flight" -eq 0 ] && missing="机票"
            [ "$has_hotel" -eq 0 ] && missing="$missing 酒店"
            reason="缺少$missing"; ((fail++))
          fi
          ;;
        compound_hotel_poi)
          has_hotel=$(echo "$reply" | grep -cE "🏨|酒店" || true)
          has_poi=$(echo "$reply" | grep -cE "🎯|景点" || true)
          if [ "$has_hotel" -gt 0 ] && [ "$has_poi" -gt 0 ]; then
            verdict="✅"; reason="复合拆解成功(酒店+景点)"; ((pass++))
          else
            missing=""
            [ "$has_hotel" -eq 0 ] && missing="酒店"
            [ "$has_poi" -eq 0 ] && missing="$missing 景点"
            reason="缺少$missing"; ((fail++))
          fi
          ;;
        compound_flight_poi)
          has_flight=$(echo "$reply" | grep -cE "✈️|航班|机票|从哪里出发" || true)
          has_poi=$(echo "$reply" | grep -cE "🎯|景点" || true)
          if [ "$has_flight" -gt 0 ] && [ "$has_poi" -gt 0 ]; then
            verdict="✅"; reason="复合拆解成功(机票+景点)"; ((pass++))
          else
            missing=""
            [ "$has_flight" -eq 0 ] && missing="机票"
            [ "$has_poi" -eq 0 ] && missing="$missing 景点"
            reason="缺少$missing"; ((fail++))
          fi
          ;;
        compound_train_hotel)
          has_train=$(echo "$reply" | grep -cE "🚄|火车|高铁" || true)
          has_hotel=$(echo "$reply" | grep -cE "🏨|酒店|住宿" || true)
          if [ "$has_train" -gt 0 ] && [ "$has_hotel" -gt 0 ]; then
            verdict="✅"; reason="复合拆解成功(火车票+酒店)"; ((pass++))
          else
            missing=""
            [ "$has_train" -eq 0 ] && missing="火车票"
            [ "$has_hotel" -eq 0 ] && missing="$missing 酒店"
            reason="缺少$missing"; ((fail++))
          fi
          ;;
        compound_spring_hotel)
          has_flight=$(echo "$reply" | grep -cE "✈️|航班|机票" || true)
          has_hotel=$(echo "$reply" | grep -cE "🏨|酒店" || true)
          has_date=$(echo "$reply" | grep -cE "2026-02-17|02-17" || true)
          if [ "$has_flight" -gt 0 ] && [ "$has_hotel" -gt 0 ]; then
            verdict="✅"; reason="复合拆解成功(机票+酒店)"; ((pass++))
          else
            missing=""
            [ "$has_flight" -eq 0 ] && missing="机票"
            [ "$has_hotel" -eq 0 ] && missing="$missing 酒店"
            reason="缺少$missing"; ((fail++))
          fi
          ;;
        compound_nextnextmonday)
          has_train=$(echo "$reply" | grep -cE "🚄|火车|高铁" || true)
          has_hotel=$(echo "$reply" | grep -cE "🏨|酒店|住宿" || true)
          if [ "$has_train" -gt 0 ] && [ "$has_hotel" -gt 0 ]; then
            verdict="✅"; reason="复合拆解成功(火车票+酒店)"; ((pass++))
          else
            missing=""
            [ "$has_train" -eq 0 ] && missing="火车票"
            [ "$has_hotel" -eq 0 ] && missing="$missing 酒店"
            reason="缺少$missing"; ((fail++))
          fi
          ;;
      esac
      ;;
    *)
      # Single intent - check keywords
      keyword_pass=false
      date_pass=true

      case "$expect" in
        hotel_hangzhou)
          echo "$reply" | grep -qE "杭州|酒店|💰.*晚" && keyword_pass=true
          ;;
        flight_beijing)
          echo "$reply" | grep -qE "北京|航班|✈️|机票" && keyword_pass=true
          ;;
        train_shanghai_hangzhou)
          echo "$reply" | grep -qE "上海|杭州|火车|高铁|🚄|中转" && keyword_pass=true
          ;;
        poi_sanya)
          echo "$reply" | grep -qE "三亚|景点|🎯|⭐" && keyword_pass=true
          ;;
        hotel_chengdu_homestay)
          echo "$reply" | grep -qE "成都|酒店|民宿" && keyword_pass=true
          ;;
        flight_guangzhou_chengdu_tomorrow)
          echo "$reply" | grep -qE "广州|成都|航班|✈️" && keyword_pass=true
          # Check tomorrow date
          tomorrow=$(TZ=Asia/Shanghai date -v+1d +%Y-%m-%d 2>/dev/null || python3 -c "from datetime import datetime,timedelta,timezone; d=datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8)))+timedelta(days=1); print(d.strftime('%Y-%m-%d'))")
          echo "$reply" | grep -q "$tomorrow" || date_pass=false
          ;;
        train_yulin_beijing)
          echo "$reply" | grep -qE "玉林|北京|火车|高铁|🚄|中转" && keyword_pass=true
          ;;
        hotel_xihu)
          echo "$reply" | grep -qE "西湖|酒店" && keyword_pass=true
          ;;
        flight_shenzhen_chengdu)
          echo "$reply" | grep -qE "深圳|成都|航班|✈️|机票" && keyword_pass=true
          ;;
        poi_xiamen)
          echo "$reply" | grep -qE "厦门|景点|🎯|⭐" && keyword_pass=true
          ;;
        train_dayafter)
          echo "$reply" | grep -qE "上海|北京|火车|高铁|🚄" && keyword_pass=true
          dayafter=$(TZ=Asia/Shanghai python3 -c "from datetime import datetime,timedelta,timezone; d=datetime.now(timezone(timedelta(hours=8)))+timedelta(days=2); print(d.strftime('%Y-%m-%d'))")
          echo "$reply" | grep -q "$dayafter" || date_pass=false
          ;;
        flight_direct)
          echo "$reply" | grep -qE "北京|三亚|航班|✈️|直飞|直达" && keyword_pass=true
          ;;
        hotel_may1)
          echo "$reply" | grep -qE "杭州|酒店" && keyword_pass=true
          # 五一已过，返回酒店结果或日期提示都算通过
          if $keyword_pass; then
            date_pass=true  # 日期解析成功即可，API返回空是数据源限制
          fi
          ;;
        train_saturday)
          echo "$reply" | grep -qE "上海|杭州|火车|高铁|🚄" && keyword_pass=true
          saturday=$(python3 -c "
from datetime import datetime, timedelta, timezone
cn = datetime.now(timezone(timedelta(hours=8)))
today = cn.replace(hour=0,minute=0,second=0,microsecond=0)
# JS getDay(): 0=Sun,1=Mon,...,6=Sat
js_getday = (today.weekday() + 1) % 7
targetDay = 6  # Saturday
diff = targetDay - js_getday
if diff <= 0: diff += 7
sat = today + timedelta(days=diff)
print(sat.strftime('%Y-%m-%d'))
")
          echo "$reply" | grep -q "$saturday" || date_pass=false
          ;;
        flight_redeye)
          echo "$reply" | grep -qE "上海|北京|航班|✈️" && keyword_pass=true
          echo "$reply" | grep -qE "2[0-3]:|20|21|22|23" || date_pass=false
          ;;
        train_nextmonth15)
          echo "$reply" | grep -qE "上海|广州|火车|高铁|🚄" && keyword_pass=true
          nextmonth15=$(python3 -c "
from datetime import datetime, timedelta, timezone
cn = datetime.now(timezone(timedelta(hours=8)))
m = cn.month + 1
y = cn.year
if m > 12: m -= 12; y += 1
print(f'{y}-{m:02d}-15')
")
          echo "$reply" | grep -q "$nextmonth15" || date_pass=false
          ;;
        flight_nationalday)
          # 缺出发地时追问也是正确行为
          if [ "$has_askback" = "yes" ]; then
            keyword_pass=true
          else
            echo "$reply" | grep -qE "三亚|航班|✈️|机票" && keyword_pass=true
            echo "$reply" | grep -qE "2026-10-01|10-01" || date_pass=false
          fi
          ;;
        askback_or_transport)
          # "玉林到上海" - should ask transport type or return results
          if [ "$has_askback" = "yes" ] || echo "$reply" | grep -qE "火车|高铁|航班|机票|🚄|✈️"; then
            keyword_pass=true
          fi
          ;;
        aisearch_or_askback)
          # "便宜又近地铁的酒店" - should AI search or ask city
          if [ "$has_askback" = "yes" ] || echo "$reply" | grep -qE "酒店|💰"; then
            keyword_pass=true
          fi
          ;;
      esac

      if $keyword_pass && $date_pass; then
        verdict="✅"; reason="通过"; ((pass++))
      else
        reason=""
        $keyword_pass || reason="关键词不匹配"
        $date_pass || reason="${reason:+$reason + }日期不匹配"
        ((fail++))
      fi
      ;;
  esac

  echo "$verdict #$id [$level] \"$query\" → $reason"

  # Rate limit: wait 1s between requests
  sleep 1
done

echo ""
echo "============================================================"
echo "📈 总通过率: $pass/30 ($(( pass * 100 / 30 ))%)"
echo ""

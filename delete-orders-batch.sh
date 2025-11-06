#!/bin/bash
# Batch delete orders from ShipStation
# Usage: ./delete-orders-batch.sh <order_number1> <order_number2> ...

if [ $# -eq 0 ]; then
    echo "Usage: ./delete-orders-batch.sh <order_number1> <order_number2> ..."
    echo ""
    echo "Example:"
    echo "  ./delete-orders-batch.sh BOX.75542308.69929380 BOX.75542113.69929224"
    echo ""
    echo "Or delete from a file:"
    echo "  cat order_numbers.txt | xargs ./delete-orders-batch.sh"
    exit 1
fi

echo "🗑️  Batch Deleting Orders"
echo "=========================="
echo ""

SUCCESS=0
FAILED=0

for order_number in "$@"; do
    echo "Deleting order: $order_number"
    if node delete-order.js --order-number "$order_number" 2>&1 | grep -q "✅ Order Deleted Successfully"; then
        echo "   ✅ Success"
        ((SUCCESS++))
    else
        echo "   ❌ Failed"
        ((FAILED++))
    fi
    echo ""
done

echo "=========================="
echo "Summary:"
echo "   ✅ Deleted: $SUCCESS"
echo "   ❌ Failed: $FAILED"
echo "=========================="


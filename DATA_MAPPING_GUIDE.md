# Data Mapping Guide: Rithum to ShipStation

This guide shows how to map Rithum (DSCO) order data to ShipStation's format based on the actual sample data provided.

## Rithum Data Structure Analysis

Based on the sample data, here are the key fields in Rithum orders:

### Order-Level Fields
- `po_number`: "EDIT.17469054370068510"
- `dsco_order_id`: 935387499
- `dsco_order_status`: "shipped"
- `dsco_order_total`: 13.3
- `dsco_lifecycle`: "completed"
- `order_type`: "dropship"
- `channel`: "2502TFBD1"
- `retailer_create_date`: "2025-05-10T19:30:37+00:00"
- `consumer_order_date`: "2025-05-10T18:49:50+00:00"

### Line Item Fields
- `line_item_sku`: "JAX-FA-010-DS"
- `line_item_title`: "Crawler - White CZ Gold Earrings"
- `line_item_quantity`: 1
- `line_item_expected_cost`: 13.3
- `line_item_extended_expected_cost_total`: 13.3
- `line_item_consumer_price`: 29
- `line_item_product_group`: "JAX-FA-010-DS"

### Shipping Address Fields
- `ship_name`: "[redacted] [redacted]"
- `ship_first_name`: "[redacted]"
- `ship_last_name`: "[redacted]"
- `ship_company`: ""
- `ship_address_1`: "[redacted]"
- `ship_address_2`: ""
- `ship_city`: "Franklin"
- `ship_region`: "IN"
- `ship_postal`: "46131"
- `ship_country`: "US"
- `ship_phone`: "[redacted]"

### Shipping Details
- `ship_carrier`: "Generic"
- `ship_method`: "Ground"
- `shipping_service_level_code`: "GCG"
- `ship_by_date`: "2025-05-23T06:59:00+00:00"
- `expected_delivery_date`: "2025-05-31T19:30:37+00:00"

### Supplier Information
- `dsco_supplier_id`: 1000062228
- `dsco_supplier_name`: "JaxKelly Inc"

---

## ShipStation Order Format

ShipStation expects orders in this format:

```json
{
  "orderNumber": "string",
  "orderDate": "datetime",
  "orderStatus": "string",
  "customerUsername": "string",
  "customerEmail": "string",
  "billTo": {},
  "shipTo": {},
  "items": [],
  "amountPaid": "number",
  "taxAmount": "number",
  "shippingAmount": "number",
  "currencyCode": "string",
  "paymentDate": "datetime",
  "paymentMethod": "string",
  "customField1": "string",
  "internalNotes": "string"
}
```

---

## Field Mapping Reference

### Essential Mappings

| ShipStation Field | Rithum Field | Notes |
|-------------------|--------------|-------|
| `orderNumber` | `po_number` | Primary order identifier |
| `orderDate` | `consumer_order_date` | Use consumer order date, fallback to retailer_create_date |
| `orderStatus` | `dsco_order_status` | Map "shipped" → "shipped", etc. |
| `amountPaid` | `dsco_order_total` | Order total cost |
| `currencyCode` | `"USD"` | Default to USD (or use currency_code if available) |

### Shipping Address Mapping

ShipStation `shipTo` object:
```json
{
  "name": "ship_name",
  "company": "ship_company",
  "street1": "ship_address_1",
  "street2": "ship_address_2",
  "city": "ship_city",
  "state": "ship_region",
  "postalCode": "ship_postal",
  "country": "ship_country",
  "phone": "ship_phone"
}
```

| ShipStation Field | Rithum Field |
|-------------------|--------------|
| `name` | `ship_name` or `ship_first_name + " " + ship_last_name` |
| `company` | `ship_company` |
| `street1` | `ship_address_1` |
| `street2` | `ship_address_2` |
| `city` | `ship_city` |
| `state` | `ship_region` |
| `postalCode` | `ship_postal` |
| `country` | `ship_country` |
| `phone` | `ship_phone` |

### Line Items Mapping

ShipStation `items` array:
```json
{
  "lineItemKey": "unique-id",
  "sku": "string",
  "name": "string",
  "imageUrl": "",
  "quantity": "number",
  "unitPrice": "number",
  "location": "",
  "options": []
}
```

| ShipStation Field | Rithum Field | Notes |
|-------------------|--------------|-------|
| `lineItemKey` | `line_item_line_number` | Unique identifier |
| `sku` | `line_item_sku` or `line_item_partner_sku` |
| `name` | `line_item_title` |
| `quantity` | `line_item_quantity` |
| `unitPrice` | `line_item_expected_cost` | Cost per unit |
| `location` | `line_item_warehouse_code` | Warehouse location |

### Custom Fields

Use ShipStation's custom fields to store additional data:

| ShipStation Field | Rithum Field | Purpose |
|-------------------|--------------|---------|
| `customField1` | `dsco_order_id` | Internal Rithum order ID |
| `customField2` | `dsco_supplier_id` | Supplier ID |
| `customField3` | `channel` | Channel identifier |
| `internalNotes` | Concatenate: Order type, lifecycle, etc. | Additional context |

---

## JavaScript Mapping Function Example

Create `src/services/mapper.js`:

```javascript
/**
 * Map a single Rithum order to ShipStation format.
 * @param {Object} rithumOrder - Rithum order data
 * @returns {Object} ShipStation order format
 */
function mapRithumToShipstation(rithumOrder) {
    // Base order information
    const shipstationOrder = {
        orderNumber: rithumOrder.po_number,
        orderDate: rithumOrder.consumer_order_date || rithumOrder.retailer_create_date,
        orderStatus: mapRithumStatus(rithumOrder.dsco_order_status || ''),
        
        // Customer information (use shipping info as fallback)
        customerUsername: '',
        customerEmail: rithumOrder.ship_email || '',
        
        // Shipping address
        shipTo: {
            name: rithumOrder.ship_name || 
                  `${rithumOrder.ship_first_name || ''} ${rithumOrder.ship_last_name || ''}`.trim(),
            company: rithumOrder.ship_company || '',
            street1: rithumOrder.ship_address_1 || '',
            street2: rithumOrder.ship_address_2 || '',
            city: rithumOrder.ship_city || '',
            state: rithumOrder.ship_region || '',
            postalCode: rithumOrder.ship_postal || '',
            country: rithumOrder.ship_country || 'US',
            phone: rithumOrder.ship_phone || ''
        },
        
        // Billing address (if available, otherwise use shipping)
        billTo: createBillingAddress(rithumOrder),
        
        // Line items
        items: [mapLineItem(rithumOrder)],
        
        // Financial information
        amountPaid: rithumOrder.dsco_order_total || 0,
        taxAmount: rithumOrder.amount_of_sales_tax_collected || 0,
        shippingAmount: rithumOrder.shipping_surcharge || 0,
        
        // Currency (default to USD)
        currencyCode: rithumOrder.currency_code || 'USD',
        
        // Payment information
        paymentDate: rithumOrder.consumer_order_date,
        paymentMethod: '',  // Not provided in Rithum data
        
        // Custom fields to store Rithum-specific data
        customField1: String(rithumOrder.dsco_order_id || ''),
        customField2: String(rithumOrder.dsco_supplier_id || ''),
        customField3: rithumOrder.channel || '',
        
        // Internal notes
        internalNotes: createInternalNotes(rithumOrder)
    };
    
    return shipstationOrder;
}

/**
 * Map line item information.
 * Note: Rithum stores line items as flat fields in the order object.
 */
function mapLineItem(rithumOrder) {
    return {
        lineItemKey: String(rithumOrder.line_item_line_number || 1),
        sku: rithumOrder.line_item_sku || rithumOrder.line_item_partner_sku,
        name: rithumOrder.line_item_title || '',
        imageUrl: '',  // Not provided
        quantity: rithumOrder.line_item_quantity || 1,
        unitPrice: rithumOrder.line_item_expected_cost || 0,
        location: rithumOrder.line_item_warehouse_code || '',
        options: []
    };
}

/**
 * Create billing address. Rithum doesn't always provide separate billing,
 * so use bill_to fields if available, otherwise use shipping address.
 */
function createBillingAddress(rithumOrder) {
    if (rithumOrder.bill_to_name) {
        return {
            name: rithumOrder.bill_to_name || '',
            company: rithumOrder.bill_to_company || '',
            street1: rithumOrder.bill_to_address_1 || '',
            street2: rithumOrder.bill_to_address_2 || '',
            city: rithumOrder.bill_to_city || '',
            state: rithumOrder.bill_to_region || '',
            postalCode: rithumOrder.bill_to_postal || '',
            country: rithumOrder.bill_to_country || 'US',
            phone: rithumOrder.bill_to_phone || ''
        };
    } else {
        // Use shipping address as billing
        return {
            name: rithumOrder.ship_name || '',
            company: rithumOrder.ship_company || '',
            street1: rithumOrder.ship_address_1 || '',
            street2: rithumOrder.ship_address_2 || '',
            city: rithumOrder.ship_city || '',
            state: rithumOrder.ship_region || '',
            postalCode: rithumOrder.ship_postal || '',
            country: rithumOrder.ship_country || 'US',
            phone: rithumOrder.ship_phone || ''
        };
    }
}

/**
 * Map Rithum order status to ShipStation status.
 */
function mapRithumStatus(rithumStatus) {
    const statusMap = {
        'shipped': 'shipped',
        'pending': 'awaiting_shipment',
        'processing': 'awaiting_shipment',
        'completed': 'shipped',
        'cancelled': 'cancelled'
    };
    return statusMap[rithumStatus.toLowerCase()] || 'awaiting_shipment';
}

/**
 * Create internal notes string with additional context.
 */
function createInternalNotes(rithumOrder) {
    const notes = [];
    
    if (rithumOrder.order_type) {
        notes.push(`Order Type: ${rithumOrder.order_type}`);
    }
    
    if (rithumOrder.dsco_lifecycle) {
        notes.push(`Lifecycle: ${rithumOrder.dsco_lifecycle}`);
    }
    
    if (rithumOrder.dsco_supplier_name) {
        notes.push(`Supplier: ${rithumOrder.dsco_supplier_name}`);
    }
    
    if (rithumOrder.ship_instructions) {
        notes.push(`Ship Instructions: ${rithumOrder.ship_instructions}`);
    }
    
    return notes.length ? notes.join(' | ') : '';
}

module.exports = {
    mapRithumToShipstation,
    mapLineItem,
    createBillingAddress,
    mapRithumStatus,
    createInternalNotes
};
```

---

## ShipStation to Rithum Tracking Update Mapping

When ShipStation sends tracking information, map it back to Rithum:

### ShipStation Tracking Update Format
```json
{
  "resource_url": "https://ssapi.shipstation.com/orders/12345678",
  "resource_type": "ORDER_NOTIFY"
}
```

Then fetch order details:
```json
{
  "orderId": 12345678,
  "trackingNumber": "1Z999AA10123456784",
  "shipDate": "2025-05-20T10:00:00",
  "carrierCode": "fedex"
}
```

### Map to Rithum Update Format
```javascript
/**
 * Map ShipStation order with tracking to Rithum update format.
 * @param {Object} shipstationOrder - ShipStation order data
 * @returns {Object} Rithum update format
 */
function mapShipstationToRithumTracking(shipstationOrder) {
    // You'll need to retrieve the Rithum order ID from your database
    // using the ShipStation order's customField1 (which stores dsco_order_id)
    
    const rithumUpdate = {
        dsco_order_id: shipstationOrder.customField1,  // This is our stored Rithum ID
        tracking_number: shipstationOrder.trackingNumber,
        carrier: shipstationOrder.carrierCode,
        ship_date: shipstationOrder.shipDate,
        status: 'shipped'  // Update Rithum status
    };
    
    return rithumUpdate;
}

module.exports = { mapShipstationToRithumTracking };
```

---

## Data Validation Checklist

Before sending to ShipStation, validate:

### Required Fields
- [ ] `orderNumber` (po_number) - Must be unique
- [ ] `orderDate` - Must be valid datetime
- [ ] `shipTo.name` - Required
- [ ] `shipTo.city` - Required
- [ ] `shipTo.state` - Required (for US orders)
- [ ] `shipTo.postalCode` - Required
- [ ] `shipTo.country` - Required
- [ ] At least one `item` with `sku` and `name`

### Conditional Validation
- [ ] If country is "US", `state` must be 2-letter code
- [ ] `postalCode` format matches country requirements
- [ ] `phone` should include country code if not US
- [ ] `unitPrice` must be >= 0
- [ ] `quantity` must be >= 1

### Optional but Recommended
- [ ] `customerEmail` - For order notifications
- [ ] `amountPaid` - Should match sum of line item costs
- [ ] `customField1` - Store Rithum order ID for tracking

---

## Common Issues & Solutions

### Issue 1: Missing Ship Email
**Problem**: Rithum doesn't always provide customer email in shipping address
**Solution**: Use empty string or set a default email

### Issue 2: Multiple Line Items
**Problem**: Rithum stores line items as flat fields, not an array
**Solution**: Your middleware should handle the structure based on `number_of_line_items`

### Issue 3: Order Status Mapping
**Problem**: Rithum statuses don't directly match ShipStation
**Solution**: Use the `map_rithum_status()` function above

### Issue 4: Missing Billing Address
**Problem**: Billing address fields are often empty
**Solution**: Use shipping address as billing address (common for dropship)

### Issue 5: Tracking Updates Back to Rithum
**Problem**: Need to update Rithum when ShipStation ships orders
**Solution**: Store `dsco_order_id` in ShipStation's `customField1` for reference

---

## Example: Complete Mapped Order

Input (Rithum):
```json
{
  "po_number": "EDIT.17469054370068510",
  "dsco_order_id": 935387499,
  "dsco_order_total": 13.3,
  "consumer_order_date": "2025-05-10T18:49:50+00:00",
  "ship_name": "John Doe",
  "ship_city": "Franklin",
  "ship_region": "IN",
  "ship_postal": "46131",
  "ship_country": "US",
  "line_item_sku": "JAX-FA-010-DS",
  "line_item_title": "Crawler - White CZ Gold Earrings",
  "line_item_quantity": 1,
  "line_item_expected_cost": 13.3
}
```

Output (ShipStation):
```json
{
  "orderNumber": "EDIT.17469054370068510",
  "orderDate": "2025-05-10T18:49:50+00:00",
  "orderStatus": "shipped",
  "customerEmail": "",
  "shipTo": {
    "name": "John Doe",
    "company": "",
    "street1": "[redacted]",
    "street2": "",
    "city": "Franklin",
    "state": "IN",
    "postalCode": "46131",
    "country": "US",
    "phone": "[redacted]"
  },
  "billTo": { /* same as shipTo */ },
  "items": [{
    "lineItemKey": "1",
    "sku": "JAX-FA-010-DS",
    "name": "Crawler - White CZ Gold Earrings",
    "imageUrl": "",
    "quantity": 1,
    "unitPrice": 13.3,
    "location": "",
    "options": []
  }],
  "amountPaid": 13.3,
  "currencyCode": "USD",
  "paymentDate": "2025-05-10T18:49:50+00:00",
  "customField1": "935387499",
  "customField2": "1000062228",
  "internalNotes": "Order Type: dropship | Lifecycle: completed | Supplier: JaxKelly Inc"
}
```

---

This mapping guide should be your reference when implementing the data transformation layer in your middleware API.


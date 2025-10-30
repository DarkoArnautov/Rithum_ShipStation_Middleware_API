const RithumClient = require('../src/services/rithumClient');

// Mock axios for testing
jest.mock('axios');
const axios = require('axios');

describe('RithumClient', () => {
    let client;
    const mockConfig = {
        apiUrl: 'https://test-api.rithum.com',
        apiKey: 'test-key',
        apiSecret: 'test-secret'
    };

    beforeEach(() => {
        client = new RithumClient(
            mockConfig.apiUrl,
            mockConfig.apiKey,
            mockConfig.apiSecret
        );
        jest.clearAllMocks();
    });

    describe('Constructor', () => {
        test('should initialize with correct configuration', () => {
            expect(client.apiUrl).toBe(mockConfig.apiUrl);
            expect(client.apiKey).toBe(mockConfig.apiKey);
            expect(client.apiSecret).toBe(mockConfig.apiSecret);
            expect(client.maxRetries).toBe(3);
        });
    });

    describe('testConnection', () => {
        test('should return success when connection is successful', async () => {
            const mockResponse = {
                data: { status: 'ok' }
            };
            axios.create.mockReturnValue({
                interceptors: {
                    request: { use: jest.fn() },
                    response: { use: jest.fn() }
                },
                get: jest.fn().mockResolvedValue(mockResponse)
            });

            const result = await client.testConnection();
            
            expect(result.success).toBe(true);
            expect(result.message).toBe('Connection successful');
        });

        test('should return failure when connection fails', async () => {
            const mockError = new Error('Connection failed');
            axios.create.mockReturnValue({
                interceptors: {
                    request: { use: jest.fn() },
                    response: { use: jest.fn() }
                },
                get: jest.fn().mockRejectedValue(mockError)
            });

            const result = await client.testConnection();
            
            expect(result.success).toBe(false);
            expect(result.message).toBe('Connection failed');
        });
    });

    describe('fetchOrders', () => {
        test('should fetch orders successfully', async () => {
            const mockOrders = [
                { id: 1, orderNumber: 'ORDER-001' },
                { id: 2, orderNumber: 'ORDER-002' }
            ];
            
            axios.create.mockReturnValue({
                interceptors: {
                    request: { use: jest.fn() },
                    response: { use: jest.fn() }
                },
                get: jest.fn().mockResolvedValue({ data: mockOrders })
            });

            const orders = await client.fetchOrders();
            
            expect(orders).toEqual(mockOrders);
        });
    });
});

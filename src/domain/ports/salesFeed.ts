import { Sale } from "../models.js";

export interface SalesFeedPort {
    fetchRecent(): Promise<Sale[]>;
}

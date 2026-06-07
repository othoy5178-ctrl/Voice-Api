const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    image: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    detail: { type: String, required: true },
    public_id: { type: String, required: true },
}, { timestamps: true });


const Product = mongoose.model('Product', productSchema);

module.exports = Product;

import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";

dotenv.config();

cloudinary.config({
    cloud_name: 'duvomsgrm',
    api_key: '752477215275183',
    api_secret: 'JDRvRBf7jeu2Z6vjE7s_MVhvVZM',
});

export default cloudinary;

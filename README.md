# Video Upload Application

A full-stack web application for uploading, managing, and playing video files. Built with React (frontend) and Node.js/Express (backend).

## Features

- Upload videos up to 100MB
- Real-time upload progress tracking
- Video thumbnail gallery
- Built-in video player
- Delete videos
- Responsive design
- Supports multiple video formats (MP4, AVI, MOV, WMV, FLV, MKV, WebM)

## Tech Stack

### Backend
- Node.js
- Express.js
- Multer (file upload handling)
- CORS enabled

### Frontend
- React
- Vite
- Modern CSS with responsive design

## Project Structure

```
video-upload-app/
├── backend/
│   ├── index.js          # Express server with upload API
│   ├── package.json      # Backend dependencies
│   └── node_modules/
├── frontend/
│   ├── src/
│   │   ├── App.jsx       # Main React component
│   │   ├── App.css       # Application styles
│   │   ├── index.css     # Global styles
│   │   └── main.jsx      # React entry point
│   ├── package.json      # Frontend dependencies
│   ├── vite.config.js    # Vite configuration
│   └── node_modules/
├── uploads/              # Video storage directory (auto-created)
└── README.md
```

## Installation

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn

### Setup Steps

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd test
   ```

2. **Install Backend Dependencies**
   ```bash
   cd backend
   npm install
   ```

3. **Install Frontend Dependencies**
   ```bash
   cd ../frontend
   npm install
   ```

## Running the Application

You need to run both the backend and frontend servers.

### Start Backend Server

```bash
cd backend
npm start
```

The backend server will start on `http://localhost:3001`

### Start Frontend Development Server

Open a new terminal:

```bash
cd frontend
npm run dev
```

The frontend will start on `http://localhost:5173`

### Access the Application

Open your browser and navigate to:
```
http://localhost:5173
```

## API Endpoints

### Upload Video
- **POST** `/api/upload`
- **Body**: FormData with 'video' field
- **Max Size**: 100MB
- **Response**:
  ```json
  {
    "message": "Video uploaded successfully",
    "filename": "unique-filename.mp4",
    "originalName": "my-video.mp4",
    "size": 12345678,
    "path": "/uploads/unique-filename.mp4"
  }
  ```

### Get All Videos
- **GET** `/api/videos`
- **Response**:
  ```json
  {
    "videos": [
      {
        "filename": "unique-filename.mp4",
        "size": 12345678,
        "uploadDate": "2025-01-01T00:00:00.000Z",
        "path": "/uploads/unique-filename.mp4"
      }
    ]
  }
  ```

### Delete Video
- **DELETE** `/api/videos/:filename`
- **Response**:
  ```json
  {
    "message": "Video deleted successfully"
  }
  ```

### Access Uploaded Videos
- **GET** `/uploads/:filename`
- Serves video files statically

## Usage

1. **Upload a Video**
   - Click the file input to select a video
   - File must be under 100MB
   - Click "Upload Video" button
   - Watch the progress bar

2. **View Videos**
   - All uploaded videos appear in the gallery
   - Click the play overlay or "Play" button to watch

3. **Delete Videos**
   - Click the "Delete" button on any video card
   - Confirm the deletion

## Configuration

### Change Backend Port
Edit `backend/index.js`:
```javascript
const PORT = 3001; // Change this
```

### Change Frontend Port
Edit `frontend/vite.config.js`:
```javascript
server: {
  port: 5173, // Change this
}
```

### Change Upload Limit
Edit `backend/index.js`:
```javascript
const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // Change this (in bytes)
  fileFilter: fileFilter
});
```

### Change API URL
Edit `frontend/src/App.jsx`:
```javascript
const API_URL = 'http://localhost:3001'; // Change this
```

## Supported Video Formats

- MP4
- AVI
- MOV
- WMV
- FLV
- MKV
- WebM

## Error Handling

The application handles:
- File size limit exceeded
- Invalid file types
- Upload failures
- Network errors
- File not found

## Development

### Backend Development
```bash
cd backend
npm run dev
```

### Frontend Development
```bash
cd frontend
npm run dev
```

### Build Frontend for Production
```bash
cd frontend
npm run build
```

## Troubleshooting

### CORS Issues
Make sure the backend has CORS enabled and is running on the correct port.

### Upload Fails
- Check file size (must be under 100MB)
- Verify file is a video format
- Check backend server is running

### Videos Don't Display
- Ensure backend is serving the `/uploads` directory
- Check browser console for errors
- Verify video format is supported by browser

## License

MIT

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.
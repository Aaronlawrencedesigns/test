import { useState, useEffect } from 'react';
import './App.css';

const API_URL = 'http://localhost:3001';

function App() {
  const [videos, setVideos] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [currentVideo, setCurrentVideo] = useState(null);

  // Fetch videos on component mount
  useEffect(() => {
    fetchVideos();
  }, []);

  const fetchVideos = async () => {
    try {
      const response = await fetch(`${API_URL}/api/videos`);
      const data = await response.json();
      setVideos(data.videos || []);
    } catch (error) {
      console.error('Error fetching videos:', error);
      setMessage('Error loading videos');
    }
  };

  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file) {
      // Check file size (100MB = 100 * 1024 * 1024 bytes)
      const maxSize = 100 * 1024 * 1024;
      if (file.size > maxSize) {
        setMessage('Error: File size exceeds 100MB limit');
        setSelectedFile(null);
        return;
      }

      // Check if it's a video file
      if (!file.type.startsWith('video/')) {
        setMessage('Error: Please select a video file');
        setSelectedFile(null);
        return;
      }

      setSelectedFile(file);
      setMessage('');
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setMessage('Please select a video file first');
      return;
    }

    const formData = new FormData();
    formData.append('video', selectedFile);

    setUploading(true);
    setUploadProgress(0);
    setMessage('');

    try {
      const xhr = new XMLHttpRequest();

      // Track upload progress
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percentComplete = (e.loaded / e.total) * 100;
          setUploadProgress(percentComplete);
        }
      });

      // Handle completion
      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          const response = JSON.parse(xhr.responseText);
          setMessage(`Success: ${response.message}`);
          setSelectedFile(null);
          setUploadProgress(0);
          fetchVideos(); // Refresh video list
          // Reset file input
          document.getElementById('video-input').value = '';
        } else {
          const error = JSON.parse(xhr.responseText);
          setMessage(`Error: ${error.error}`);
        }
        setUploading(false);
      });

      // Handle errors
      xhr.addEventListener('error', () => {
        setMessage('Error: Upload failed');
        setUploading(false);
        setUploadProgress(0);
      });

      xhr.open('POST', `${API_URL}/api/upload`);
      xhr.send(formData);
    } catch (error) {
      console.error('Error uploading video:', error);
      setMessage(`Error: ${error.message}`);
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleDelete = async (filename) => {
    if (!confirm('Are you sure you want to delete this video?')) {
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/videos/${filename}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        setMessage('Video deleted successfully');
        fetchVideos();
        if (currentVideo && currentVideo.filename === filename) {
          setCurrentVideo(null);
        }
      } else {
        const error = await response.json();
        setMessage(`Error: ${error.error}`);
      }
    } catch (error) {
      console.error('Error deleting video:', error);
      setMessage(`Error: ${error.message}`);
    }
  };

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Video Upload Application</h1>
      </header>

      <main className="app-main">
        {/* Upload Section */}
        <section className="upload-section">
          <h2>Upload Video</h2>
          <div className="upload-container">
            <input
              id="video-input"
              type="file"
              accept="video/*"
              onChange={handleFileSelect}
              disabled={uploading}
            />

            {selectedFile && (
              <div className="file-info">
                <p><strong>Selected:</strong> {selectedFile.name}</p>
                <p><strong>Size:</strong> {formatFileSize(selectedFile.size)}</p>
              </div>
            )}

            <button
              onClick={handleUpload}
              disabled={!selectedFile || uploading}
              className="upload-button"
            >
              {uploading ? 'Uploading...' : 'Upload Video'}
            </button>

            {uploading && (
              <div className="progress-container">
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{ width: `${uploadProgress}%` }}
                  ></div>
                </div>
                <p>{Math.round(uploadProgress)}%</p>
              </div>
            )}

            {message && (
              <div className={`message ${message.startsWith('Error') ? 'error' : 'success'}`}>
                {message}
              </div>
            )}
          </div>
        </section>

        {/* Video Player Section */}
        {currentVideo && (
          <section className="player-section">
            <h2>Now Playing</h2>
            <div className="video-player">
              <video
                controls
                src={`${API_URL}${currentVideo.path}`}
                className="video-element"
              >
                Your browser does not support the video tag.
              </video>
              <p className="video-name">{currentVideo.filename}</p>
            </div>
          </section>
        )}

        {/* Video List Section */}
        <section className="video-list-section">
          <h2>Uploaded Videos ({videos.length})</h2>
          {videos.length === 0 ? (
            <p className="no-videos">No videos uploaded yet. Upload your first video above!</p>
          ) : (
            <div className="video-grid">
              {videos.map((video) => (
                <div key={video.filename} className="video-card">
                  <div className="video-thumbnail">
                    <video
                      src={`${API_URL}${video.path}`}
                      className="thumbnail-video"
                    />
                    <div className="play-overlay" onClick={() => setCurrentVideo(video)}>
                      <span className="play-icon">▶</span>
                    </div>
                  </div>
                  <div className="video-info">
                    <p className="video-filename" title={video.filename}>
                      {video.filename}
                    </p>
                    <p className="video-meta">
                      {formatFileSize(video.size)} • {formatDate(video.uploadDate)}
                    </p>
                    <div className="video-actions">
                      <button
                        onClick={() => setCurrentVideo(video)}
                        className="play-button"
                      >
                        Play
                      </button>
                      <button
                        onClick={() => handleDelete(video.filename)}
                        className="delete-button"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
